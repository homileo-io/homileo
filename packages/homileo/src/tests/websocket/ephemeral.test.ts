// @module-tag int
// @module-tag websocket
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sweepPresence } from "../../websocket/ephemeral.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  nextEvent,
  noEvent,
  openSocket,
  request,
  startSocketServer,
  SUBSCRIBED,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

interface PresenceEvent {
  principalId: string;
  status: "online" | "offline";
}

const fixtures = chatFixtures();
let nodeA: LocalSocketServer;
let nodeB: LocalSocketServer;
const opened: ClientSocket[] = [];
const orgs: string[] = [];

const connect = async (
  who: { tereoUserId: string | null },
  org: string,
  node = nodeA
) => {
  const socket = await openSocket(
    personToken({ userId: who.tereoUserId!, org }),
    node.url
  );
  opened.push(socket);
  return socket;
};

const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

/** A watcher socket already watching `ids`. */
const watcher = async (org: string, ids: string[], node = nodeA) => {
  const socket = await connect(await fixtures.principal(), org, node);
  const ack = await request(socket, "presence.watch", { principalIds: ids });
  expect(ack).toMatchObject({ ok: true });
  return { socket, ack };
};

beforeAll(async () => {
  [nodeA, nodeB] = [await startSocketServer(), await startSocketServer()];
});

afterEach(async () => {
  for (const socket of opened.splice(0)) socket.close();
  for (const org of orgs.splice(0)) await redis.del(`homileo:presence:${org}`);
});

afterAll(async () => {
  await Promise.all([nodeA.close(), nodeB.close()]);
  await fixtures.cleanup();
});

const pair = async () => {
  const org = uuidv7();
  const [alice, bob] = [await fixtures.principal(), await fixtures.principal()];
  const session = await fixtures.session({ org, type: "group" });
  await fixtures.participant(session, alice);
  await fixtures.participant(session, bob);
  return {
    org,
    alice,
    bob,
    session,
    aliceSocket: await connect(alice, org),
    bobSocket: await connect(bob, org),
  };
};

describe("typing", () => {
  it("reaches the other participant with its expiry, and not the sender", async () => {
    const { alice, session, aliceSocket, bobSocket } = await pair();
    const received = nextEvent(bobSocket, "typing");
    const echoed = noEvent(aliceSocket, "typing");

    const ack = await request(aliceSocket, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    expect(await received).toEqual({
      sessionId: session.id,
      principalId: alice.id,
      typing: true,
      expiresInMs: 6000,
    });
    await echoed;
  });

  it("broadcasts typing.stop with typing false", async () => {
    const { alice, session, aliceSocket, bobSocket } = await pair();
    const received = nextEvent(bobSocket, "typing");

    const ack = await request(aliceSocket, "typing.stop", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    expect(await received).toEqual({
      sessionId: session.id,
      principalId: alice.id,
      typing: false,
      expiresInMs: 6000,
    });
  });

  it("acks not_found to a reader who is not a participant, and broadcasts nothing", async () => {
    const { org, bobSocket } = await pair();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const outsider = await connect(await fixtures.principal(), org);
    expect(
      await request(outsider, "subscribe", { sessionId: session.id })
    ).toEqual(SUBSCRIBED);
    expect(
      await request(bobSocket, "subscribe", { sessionId: session.id })
    ).toEqual(SUBSCRIBED);
    const heard = noEvent(bobSocket, "typing");

    const ack = await request(outsider, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toMatchObject({ ok: false, error: { code: "not_found" } });
    await heard;
  });

  it("acks not_found for a session that does not exist, invalid_request for junk", async () => {
    const { aliceSocket } = await pair();

    expect(
      await request(aliceSocket, "typing.start", { sessionId: uuidv7() })
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await request(aliceSocket, "typing.start", { sessionId: "nope" })
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("acks a second typing.start within 2 s but does not rebroadcast it", async () => {
    const { session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    const second = noEvent(bobSocket, "typing", 500);

    const ack = await request(aliceSocket, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    await second;
  });

  it("broadcasts a typing.start right after a typing.stop", async () => {
    const { session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    const stop = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.stop", { sessionId: session.id });
    await stop;
    const again = nextEvent<{ typing: boolean }>(bobSocket, "typing");

    await request(aliceSocket, "typing.start", { sessionId: session.id });

    expect((await again).typing).toBe(true);
  });

  it("acks a throttled typing.start without reading the session again", async () => {
    const { alice, session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    // Would be not_found if read: the throttled start is answered before any read.
    await prisma.sessionParticipant.updateMany({
      where: { sessionId: session.id, userId: alice.id },
      data: { leftAt: new Date() },
    });
    const silent = noEvent(bobSocket, "typing", 500);

    const ack = await request(aliceSocket, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    await silent;
  });

  it("broadcasts typing.stop even right after a start", async () => {
    const { session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    const stop = nextEvent<{ typing: boolean }>(bobSocket, "typing");

    await request(aliceSocket, "typing.stop", { sessionId: session.id });

    expect((await stop).typing).toBe(false);
  });
});

describe("presence", () => {
  it("tells watchers when a principal's first socket connects, and not for the second", async () => {
    const org = newOrg();
    const who = await fixtures.principal();
    const { socket: watching } = await watcher(org, [who.id]);
    const online = nextEvent<PresenceEvent>(watching, "presence");

    await connect(who, org);

    expect(await online).toEqual({ principalId: who.id, status: "online" });
    const quiet = noEvent(watching, "presence");
    await connect(who, org);
    await quiet;
  });

  it("answers presence.watch with the current statuses", async () => {
    const org = newOrg();
    const [on, off] = [await fixtures.principal(), await fixtures.principal()];
    await connect(on, org);

    const { ack } = await watcher(org, [on.id, off.id]);

    expect(ack).toEqual({
      ok: true,
      statuses: { [on.id]: "online", [off.id]: "offline" },
    });
  });

  it("sends offline only when the last socket closes, across nodes", async () => {
    const org = newOrg();
    const who = await fixtures.principal();
    const { socket: watching } = await watcher(org, [who.id]);
    const online = nextEvent(watching, "presence");
    const first = await connect(who, org, nodeA);
    const second = await connect(who, org, nodeB);
    await online;

    const stillOnline = noEvent(watching, "presence", 500);
    first.close();
    await stillOnline;

    const offline = nextEvent<PresenceEvent>(watching, "presence");
    second.close();
    expect(await offline).toEqual({ principalId: who.id, status: "offline" });
  });

  it("presence.heartbeat acks and brings an expired principal back online", async () => {
    const org = newOrg();
    const who = await fixtures.principal();
    const { socket: watching } = await watcher(org, [who.id]);
    const socket = await connect(who, org);
    await nextEvent(watching, "presence");
    await redis.del(`homileo:presence:${org}`);
    const online = nextEvent<PresenceEvent>(watching, "presence");

    const ack = await request(socket, "presence.heartbeat", {});

    expect(ack).toEqual({ ok: true });
    expect((await online).status).toBe("online");
  });

  it("expire sends offline once even when two nodes run it", async () => {
    const org = newOrg();
    const who = await fixtures.principal();
    const { socket: watching } = await watcher(org, [who.id]);
    await connect(who, org);
    await nextEvent(watching, "presence");
    const seen: PresenceEvent[] = [];
    watching.on("presence", (e: PresenceEvent) => seen.push(e));

    const later = Date.now() + 61_000;
    await Promise.all([
      sweepPresence(nodeA.io, org, later),
      sweepPresence(nodeB.io, org, later),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(seen).toEqual([{ principalId: who.id, status: "offline" }]);
  });

  it("does not leak presence across organizations", async () => {
    const org = newOrg();
    const other = newOrg();
    const who = await fixtures.principal();
    const { socket: watching } = await watcher(other, [who.id]);
    const quiet = noEvent(watching, "presence");

    await connect(who, org);

    await quiet;
  });
});

describe("presence.watch", () => {
  it("replaces the watched set", async () => {
    const org = newOrg();
    const [a, b] = [await fixtures.principal(), await fixtures.principal()];
    const { socket: watching } = await watcher(org, [a.id]);
    await request(watching, "presence.watch", { principalIds: [b.id] });
    const quiet = noEvent(watching, "presence");

    await connect(a, org);

    await quiet;
    const online = nextEvent<PresenceEvent>(watching, "presence");
    await connect(b, org);
    expect((await online).principalId).toBe(b.id);
  });

  it("acks too_many_watched for 201 ids", async () => {
    const org = newOrg();
    const socket = await connect(await fixtures.principal(), org);

    const ack = await request(socket, "presence.watch", {
      principalIds: Array.from({ length: 201 }, () => uuidv7()),
    });

    expect(ack).toMatchObject({
      ok: false,
      error: { code: "too_many_watched" },
    });
  });

  it("accepts 200 ids", async () => {
    const org = newOrg();
    const socket = await connect(await fixtures.principal(), org);

    const ack = await request(socket, "presence.watch", {
      principalIds: Array.from({ length: 200 }, () => uuidv7()),
    });

    expect(ack).toMatchObject({ ok: true });
  });

  it.each([
    ["not an array", { principalIds: "x" }],
    ["a malformed id", { principalIds: ["nope"] }],
    ["no body", undefined],
  ])("acks invalid_request for %s", async (_name, payload) => {
    const org = newOrg();
    const socket = await connect(await fixtures.principal(), org);

    const ack = await request(socket, "presence.watch", payload);

    expect(ack).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });
});
