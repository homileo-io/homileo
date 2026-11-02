// @module-tag int
// @module-tag websocket
// @module-tag access
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../prisma/generated/client/index.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  leaveSpaceOfIfUnused,
  recheckSockets,
  sweepSockets,
} from "../../websocket/rooms.js";
import {
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../../realtime/rooms.js";
import {
  collect,
  eventually,
  nextEvent,
  noEvent,
  openLocalSocket,
  openReadySocket,
  request,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

const connectAs = async (
  who: Principal,
  org: string,
  perms = ["homileo.spaces.read"]
) => {
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

  it("drops a left room from the socket's explicit subscriptions, and tells it unsubscribed", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const client = await connectAs(who, org);
    await request(client, "subscribe", { sessionId: session.id });
    await request(client, "subscribe", { spaceId: space.id });
    const server = serverSocket(client);
    const notices = collect(client, "unsubscribed");
    await prisma.space.update({
      where: { id: space.id },
      data: { visibility: "members" },
    });

    await recheckSockets([server]);

    expect(server.data.subscriptions.size).toBe(0);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(false);
    await eventually(() => notices.length === 2);
    expect(notices).toEqual(
      expect.arrayContaining([{ sessionId: session.id }, { spaceId: space.id }])
    );
  });

  it("tells a socket of another node unsubscribed when this node's re-check drops its subscription", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    // On the shared server, so this node reaches it through Redis.
    const { socket: client } = await openReadySocket(
      personToken({ userId: who.tereoUserId!, org })
    );
    opened.push(client);
    expect(
      await request(client, "subscribe", { sessionId: session.id })
    ).toMatchObject({ ok: true });
    const notice = nextEvent(client, "unsubscribed");
    await prisma.space.update({
      where: { id: space.id },
      data: { visibility: "members" },
    });

    await recheckSockets(
      await local.io.in(sessionRoom(session.id)).fetchSockets()
    );

    expect(await notice).toEqual({ sessionId: session.id });
  });

  it("sends no unsubscribed for the socket's own unsubscribe", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const client = await connectAs(who, org);
    await request(client, "subscribe", { sessionId: session.id });
    const silent = noEvent(client, "unsubscribed", 300);

    await request(client, "unsubscribe", { sessionId: session.id });

    await silent;
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

describe("leaveSpaceOfIfUnused", () => {
  it("keeps spaceof: when another session room of the space is joined while it counts", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const leaving = await fixtures.session({ space, access: "space" });
    const joining = await fixtures.session({ space, access: "space" });
    const elsewhere = await fixtures.session({
      space: await fixtures.space({ org, visibility: "public" }),
      access: "space",
    });
    const server = serverSocket(await connectAs(who, org));
    await server.join([
      sessionRoom(leaving.id),
      sessionRoom(elsewhere.id),
      spaceOfRoom(space.id),
    ]);

    // The rooms are read before the first await, so this join lands during the count.
    const left = leaveSpaceOfIfUnused(
      server,
      space.id,
      sessionRoom(leaving.id)
    );
    await server.join([sessionRoom(joining.id), spaceOfRoom(space.id)]);
    await left;

    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
  });

  it("leaves spaceof: when no other session room of the space remains", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const leaving = await fixtures.session({ space, access: "space" });
    const elsewhere = await fixtures.session({
      space: await fixtures.space({ org, visibility: "public" }),
      access: "space",
    });
    const server = serverSocket(await connectAs(who, org));
    await server.join([
      sessionRoom(leaving.id),
      sessionRoom(elsewhere.id),
      spaceOfRoom(space.id),
    ]);

    await leaveSpaceOfIfUnused(server, space.id, sessionRoom(leaving.id));

    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(false);
  });
});

describe("sweepSockets", () => {
  it("joins a participation and a membership room whose join was lost", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, who);
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.participant(session, who);
    const server = serverSocket(await connectAs(who, org));
    // As if the adapter's join never reached this node.
    await server.leave(sessionRoom(session.id));
    await server.leave(spaceOfRoom(space.id));
    await server.leave(spaceRoom(space.id));

    await sweepSockets(local.io);

    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
    expect(server.rooms.has(spaceRoom(space.id))).toBe(true);
  });

  it("drops a subscription whose room is now held for participation, keeping the room", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const client = await connectAs(who, org);
    await request(client, "subscribe", { sessionId: session.id });
    // Added on another node, which could not touch this socket's list.
    await fixtures.participant(session, who);
    const server = serverSocket(client);

    await sweepSockets(local.io);

    expect(server.data.subscriptions.size).toBe(0);
    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
  });

  it("leaves a participation room whose removal it missed, though it can still read the session, keeping a subscription", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const watched = await fixtures.session({ space, access: "space" });
    await fixtures.participant(session, who);
    const client = await connectAs(who, org);
    await request(client, "subscribe", { sessionId: watched.id });
    const server = serverSocket(client);
    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
    // Removed with no event: as if the removal fanned out before the socket joined.
    await prisma.sessionParticipant.deleteMany({
      where: { sessionId: session.id },
    });

    await sweepSockets(local.io);

    expect(server.rooms.has(sessionRoom(session.id))).toBe(false);
    expect(server.rooms.has(sessionRoom(watched.id))).toBe(true);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
  });

  it("still leaves the rooms a socket can no longer read", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, who);
    const server = serverSocket(await connectAs(who, org));
    await prisma.spaceMember.deleteMany({ where: { spaceId: space.id } });

    await sweepSockets(local.io);

    expect(server.rooms.has(spaceRoom(space.id))).toBe(false);
  });
});
