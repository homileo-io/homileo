// @module-tag int
// @module-tag websocket
// @module-tag access
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../prisma/generated/client/index.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { recheckSockets } from "../../websocket/rooms.js";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../../realtime/rooms.js";
import {
  openLocalSocket,
  request,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

const connectAs = async (who: Principal, org: string, perms: string[] = []) => {
  const socket = await openLocalSocket(
    personToken({ userId: who.tereoUserId!, org, perms }),
    local
  );
  opened.push(socket);
  return socket;
};

const serverSocket = (socket: ClientSocket) => {
  const found = local.io.of("/").sockets.get(socket.id!);
  if (!found) throw new Error("no server socket");
  return found;
};

beforeAll(async () => {
  local = await startSocketServer();
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await local.close();
  await fixtures.cleanup();
});

describe("recheckSockets", () => {
  it("leaves the space, its sessions and spaceof once membership of a members-only space is gone", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, who);
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.participant(session, who);
    const socket = await connectAs(who, org);
    const server = serverSocket(socket);
    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
    await prisma.spaceMember.deleteMany({ where: { spaceId: space.id } });

    const left = await recheckSockets([server]);

    expect(left.get(server.id)?.sort()).toEqual(
      [
        spaceRoom(space.id),
        sessionRoom(session.id),
        spaceOfRoom(space.id),
      ].sort()
    );
    expect([...server.rooms].sort()).toEqual(
      [server.id, userRoom(org, who.id)].sort()
    );
  });

  it("judges each socket with its own token's permissions", async () => {
    const org = uuidv7();
    const space = await fixtures.space({ org, visibility: "members" });
    const admin = await fixtures.principal();
    const plain = await fixtures.principal();
    await fixtures.member(space, admin);
    await fixtures.member(space, plain);
    const adminSocket = serverSocket(
      await connectAs(admin, org, ["homileo.chat.admin"])
    );
    const plainSocket = serverSocket(await connectAs(plain, org));
    await prisma.spaceMember.deleteMany({ where: { spaceId: space.id } });

    const left = await recheckSockets([adminSocket, plainSocket]);

    expect(left.get(adminSocket.id) ?? []).toEqual([]);
    expect(adminSocket.rooms.has(spaceRoom(space.id))).toBe(true);
    expect(left.get(plainSocket.id)).toEqual([spaceRoom(space.id)]);
    expect(plainSocket.rooms.has(spaceRoom(space.id))).toBe(false);
  });

  it("judges only the rooms the socket was in when called, keeping one joined while it loads", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    await fixtures.member(space, who);
    const session = await fixtures.session({ space, access: "space" });
    const server = serverSocket(await connectAs(who, org));

    const checking = recheckSockets([server]);
    await server.join(sessionRoom(session.id));
    const left = await checking;

    expect(left.get(server.id)).toEqual([]);
    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
  });

  it("keeps spaceof while a session room of that space joined during the check remains", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const lost = await fixtures.session({ space, access: "members" });
    const joined = await fixtures.session({ space, access: "space" });
    await fixtures.participant(lost, who);
    const server = serverSocket(await connectAs(who, org));
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
    await prisma.sessionParticipant.deleteMany({
      where: { sessionId: lost.id },
    });

    const checking = recheckSockets([server]);
    await server.join(sessionRoom(joined.id));
    const left = await checking;

    expect(left.get(server.id)).toEqual([sessionRoom(lost.id)]);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
    expect(server.rooms.has(sessionRoom(joined.id))).toBe(true);
  });

  it("drops a left room from the socket's explicit subscriptions", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const client = await connectAs(who, org);
    await request(client, "subscribe", { sessionId: session.id });
    const server = serverSocket(client);
    await prisma.space.update({
      where: { id: space.id },
      data: { visibility: "members" },
    });

    await recheckSockets([server]);

    expect(server.data.subscriptions.size).toBe(0);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(false);
  });

  it("keeps spaceof while another session of the space stays readable", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ space, access: "space" });
    const closed = await fixtures.session({ space, access: "members" });
    await fixtures.participant(closed, who);
    const server = serverSocket(await connectAs(who, org));
    await request(opened[opened.length - 1], "subscribe", {
      sessionId: open.id,
    });
    await prisma.sessionParticipant.updateMany({
      where: { sessionId: closed.id },
      data: { leftAt: new Date() },
    });

    const left = await recheckSockets([server]);

    expect(left.get(server.id)).toEqual([sessionRoom(closed.id)]);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
    expect(server.rooms.has(sessionRoom(open.id))).toBe(true);
  });

  it("works on the remote sockets of fetchSockets", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, who);
    const client = await connectAs(who, org);
    await prisma.spaceMember.deleteMany({ where: { spaceId: space.id } });
    const remote = await local.io.in(spaceRoom(space.id)).fetchSockets();

    const left = await recheckSockets(remote);

    expect(left.get(client.id!)).toEqual([spaceRoom(space.id)]);
    expect(serverSocket(client).rooms.has(spaceRoom(space.id))).toBe(false);
  });
});
