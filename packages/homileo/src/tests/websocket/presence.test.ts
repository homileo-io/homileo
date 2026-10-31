// @module-tag int
// @module-tag websocket
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sweepPresence } from "../../websocket/ephemeral.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  noEvent,
  nextEvent,
  openSocket,
  request,
  startSocketServer,
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
