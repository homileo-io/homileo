// @module-tag int
// @module-tag websocket
// @module-tag race
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../support/chatFixtures.js";
import type { Ack } from "../../websocket/types.js";
import { personToken } from "../support/tokens.js";
import { redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  openSocket,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const fixtures = chatFixtures();
let node: LocalSocketServer;
const opened: ClientSocket[] = [];
const org = uuidv7();

beforeAll(async () => {
  node = await startSocketServer();
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await node.close();
  await redis.del(`homileo:presence:${org}`);
  await fixtures.cleanup();
});

describe("presence.watch", () => {
  it("leaves the first list's rooms when a second watch arrives before the first finishes", async () => {
    const who = await fixtures.principal();
    const socket = await openSocket(
      personToken({ userId: who.tereoUserId!, org }),
      node.url
    );
    opened.push(socket);
    const onServer = node.io.of("/").sockets.get(socket.id!)!;
    const first = [uuidv7(), uuidv7()];
    const second = [uuidv7()];

    // Both handlers start in the same tick, as two packets parsed from one chunk do.
    const [handler] = onServer.listeners("presence.watch");
    const acks = [first, second].map(
      (principalIds) =>
        new Promise<Ack>((resolve) => handler({ principalIds }, resolve))
    );
    for (const ack of await Promise.all(acks)) {
      expect(ack).toMatchObject({ ok: true });
    }

    const watching = [...onServer.rooms].filter((r) =>
      r.startsWith("presence:")
    );
    expect(watching).toEqual(second.map((id) => `presence:${org}:${id}`));
    expect([...onServer.data.watched]).toEqual(second);
  });
});
