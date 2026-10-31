// @module-tag int
// @module-tag websocket
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../prisma/generated/client/index.js";
import { decodeSyncCursor } from "../../realtime/syncCursor.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { db } from "../../utils/db/index.js";
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
  socketsIn,
  startSocketServer,
  SUBSCRIBED,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

const connectAs = async (who: Principal, org: string) => {
  const socket = await openLocalSocket(
    personToken({ userId: who.tereoUserId!, org }),
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

/** Subscribes `socket` to `count` rooms of sessions that do not exist, server side. */
const fill = async (socket: ClientSocket, count: number) => {
  const server = serverSocket(socket);
  const rooms = Array.from({ length: count }, () => sessionRoom(uuidv7()));
  for (const room of rooms) server.data.subscriptions.add(room);
  await server.join(rooms);
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

describe("socket rooms on connect", () => {
  it("joins the personal room, member spaces and current sessions of the token's organization only", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org });
    await fixtures.member(space, who);
    const inSpace = await fixtures.session({ space, access: "space" });
    await fixtures.participant(inSpace, who);
    const direct = await fixtures.session({ org, type: "group" });
    await fixtures.participant(direct, who);
    const left = await fixtures.session({ org, type: "group" });
    await fixtures.participant(left, who, "member", { left: true });
    const elsewhere = await fixtures.space({});
    await fixtures.member(elsewhere, who);
    const elsewhereSession = await fixtures.session({ type: "group" });
    await fixtures.participant(elsewhereSession, who);

    const socket = await connectAs(who, org);

    expect([...serverSocket(socket).rooms].sort()).toEqual(
      [
        socket.id!,
        userRoom(org, who.id),
        spaceRoom(space.id),
        sessionRoom(inSpace.id),
        spaceOfRoom(space.id),
        sessionRoom(direct.id),
      ].sort()
    );
    expect(await socketsIn(local.io, spaceRoom(space.id))).toEqual([socket.id]);
    expect(await socketsIn(local.io, spaceRoom(elsewhere.id))).toEqual([]);
  });

  it("skips a participation in a session the principal can no longer read", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.participant(session, who);

    const socket = await connectAs(who, org);

    expect(serverSocket(socket).rooms.has(sessionRoom(session.id))).toBe(false);
  });
});

describe("subscribe", () => {
  it("joins a readable public-space session and acks ok", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);

    const before = await db.events.tail();

    const ack = await request<{ ok: true; until: string }>(
      socket,
      "subscribe",
      { sessionId: session.id }
    );

    expect(ack).toEqual({ ok: true, until: expect.any(String) });
    const until = decodeSyncCursor(ack.until);
    expect(until.id).toBe(0n);
    expect(until.txId).toBeGreaterThanOrEqual(before.txId);
    expect(await socketsIn(local.io, sessionRoom(session.id))).toEqual([
      socket.id,
    ]);
    expect(await socketsIn(local.io, spaceOfRoom(space.id))).toEqual([
      socket.id,
    ]);
    expect([...serverSocket(socket).data.subscriptions]).toEqual([
      sessionRoom(session.id),
    ]);
  });

  it("joins a readable space", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const socket = await connectAs(who, org);

    const ack = await request(socket, "subscribe", { spaceId: space.id });

    expect(ack).toEqual(SUBSCRIBED);
    expect(await socketsIn(local.io, spaceRoom(space.id))).toEqual([socket.id]);
  });

  it("acks not_found for an unreadable session, another organization's, and a missing one", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const hidden = await fixtures.space({ org, visibility: "members" });
    const unreadable = await fixtures.session({
      space: hidden,
      access: "space",
    });
    const foreignSpace = await fixtures.space({ visibility: "public" });
    const foreign = await fixtures.session({
      space: foreignSpace,
      access: "space",
    });
    const socket = await connectAs(who, org);

    const acks = [
      await request(socket, "subscribe", { sessionId: unreadable.id }),
      await request(socket, "subscribe", { sessionId: foreign.id }),
      await request(socket, "subscribe", { sessionId: uuidv7() }),
      await request(socket, "subscribe", { spaceId: hidden.id }),
    ];

    for (const ack of acks) {
      expect(ack).toEqual({
        ok: false,
        error: { code: "not_found", message: expect.any(String) },
      });
    }
    expect(await socketsIn(local.io, sessionRoom(unreadable.id))).toEqual([]);
    expect(await socketsIn(local.io, sessionRoom(foreign.id))).toEqual([]);
  });

  it("acks invalid_request for a malformed payload", async () => {
    const who = await fixtures.principal();
    const socket = await connectAs(who, uuidv7());

    const acks = [
      await request(socket, "subscribe", { sessionId: "nope" }),
      await request(socket, "subscribe", {}),
      await request(socket, "subscribe", {
        sessionId: uuidv7(),
        spaceId: uuidv7(),
      }),
    ];

    for (const ack of acks) {
      expect(ack).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
  });

  it("acks too_many_subscriptions for the 201st", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);
    await fill(socket, 200);

    const ack = await request(socket, "subscribe", { sessionId: session.id });

    expect(ack).toEqual({
      ok: false,
      error: { code: "too_many_subscriptions", message: expect.any(String) },
    });
    expect(await socketsIn(local.io, sessionRoom(session.id))).toEqual([]);
  });

  it("acks ok again for a room already subscribed, at the limit", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);
    await request(socket, "subscribe", { sessionId: session.id });
    await fill(socket, 199);

    expect(
      await request(socket, "subscribe", { sessionId: session.id })
    ).toEqual(SUBSCRIBED);
  });
});

describe("unsubscribe", () => {
  it("leaves a subscribed session's room and its spaceof room", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);
    await request(socket, "subscribe", { sessionId: session.id });

    const ack = await request(socket, "unsubscribe", { sessionId: session.id });

    expect(ack).toEqual({ ok: true });
    expect(await socketsIn(local.io, sessionRoom(session.id))).toEqual([]);
    expect(await socketsIn(local.io, spaceOfRoom(space.id))).toEqual([]);
    expect(serverSocket(socket).data.subscriptions.size).toBe(0);
  });

  it("keeps spaceof while another session of the space is still joined", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const first = await fixtures.session({ space, access: "space" });
    const second = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);
    await request(socket, "subscribe", { sessionId: first.id });
    await request(socket, "subscribe", { sessionId: second.id });

    await request(socket, "unsubscribe", { sessionId: first.id });

    expect(await socketsIn(local.io, spaceOfRoom(space.id))).toEqual([
      socket.id,
    ]);
  });

  it("never leaves the rooms joined for membership or participation", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org });
    await fixtures.member(space, who);
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.participant(session, who);
    const socket = await connectAs(who, org);
    expect(
      await request(socket, "subscribe", { sessionId: session.id })
    ).toEqual(SUBSCRIBED);

    await request(socket, "unsubscribe", { sessionId: session.id });
    await request(socket, "unsubscribe", { spaceId: space.id });

    const rooms = serverSocket(socket).rooms;
    expect(rooms.has(sessionRoom(session.id))).toBe(true);
    expect(rooms.has(spaceOfRoom(space.id))).toBe(true);
    expect(rooms.has(spaceRoom(space.id))).toBe(true);
  });

  it("keeps a subscribed room once its subscriber became a participant or member there, though still listed", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const socket = await connectAs(who, org);
    await request(socket, "subscribe", { sessionId: session.id });
    await request(socket, "subscribe", { spaceId: space.id });
    // Joined for this on another node, which could not touch this socket's list.
    await fixtures.participant(session, who);
    await fixtures.member(space, who);

    await request(socket, "unsubscribe", { sessionId: session.id });
    await request(socket, "unsubscribe", { spaceId: space.id });

    const server = serverSocket(socket);
    expect(server.rooms.has(sessionRoom(session.id))).toBe(true);
    expect(server.rooms.has(spaceOfRoom(space.id))).toBe(true);
    expect(server.rooms.has(spaceRoom(space.id))).toBe(true);
    expect(server.data.subscriptions.size).toBe(0);
  });
});
