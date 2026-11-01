// @module-tag int
// @module-tag sync
// @module-tag websocket
import { catchUp, drainSync, syncHead } from "../../support/sync.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../support/spaceApi.js";
import { sendMessage } from "../../support/messageApi.js";
import type { JsonResponse } from "../../support/http.js";
import { prisma } from "../../../utils/db/prisma.js";
import {
  collect,
  eventually,
  openReadySocket,
  openSocket,
  type ClientSocket,
} from "../../support/sockets.js";

const api = spaceApiFixtures();
const { fixtures } = api;
const opened: ClientSocket[] = [];

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await api.cleanup();
});

// Against the shared server: its own sockets, fan-out and /sync.
describe("reconnecting through /sync", () => {
  it("recovers every message in commit order from the socket's events, a replay from the first cursor and the events buffered during it", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const alice = await api.actor(org);
    const session = await fixtures.session({ org, type: "group" });
    await fixtures.participant(session, owner.principal, "owner");
    await fixtures.participant(session, alice.principal);
    const sentIds: string[] = [];
    const send = async (body: string) => {
      const res = await sendMessage(session.id, owner.token, { body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      sentIds.push(res.body.message.id);
    };

    const first = await syncHead(alice.token);
    const socket = await openSocket(alice.token);
    opened.push(socket);
    const live = collect<JsonResponse["body"]>(socket, "message.created");
    await send("one");
    await send("two");
    await eventually(() => live.length === 2);
    socket.close();

    await send("three");
    await send("four");
    await send("five");

    // Connected and buffering before the replay, as Decision 2 has the client do; a message
    // sent during the replay reaches the buffer, the replay, or both.
    const again = await openSocket(alice.token);
    opened.push(again);
    const buffered = collect<JsonResponse["body"]>(again, "message.created");
    const [{ events }] = await Promise.all([
      drainSync(alice.token, first),
      send("six"),
    ]);
    await eventually(() => buffered.length === 1);

    const seen = new Set<string>();
    const applied = [...live, ...events, ...buffered].filter((e) => {
      if (e.type !== "message.created" || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    expect(applied.map((e) => e.payload.message.id)).toEqual(sentIds);
    expect(buffered.map((e) => e.payload.message.id)).toEqual([sentIds[5]]);
  });

  it("waits for an older open transaction before catching up past an event committed while the socket was down", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const alice = await api.actor(org);
    const session = await fixtures.session({ org, type: "group" });
    await fixtures.participant(session, owner.principal, "owner");
    await fixtures.participant(session, alice.principal);
    const since = await syncHead(alice.token);

    // An older transaction holds a transaction id and stays open.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    const holding = new Promise<void>((resolve) => (began = resolve));
    const older = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_current_xact_id()::text`;
        began();
        await released;
      },
      { timeout: 30_000 }
    );
    try {
      await holding;
      // Committed while alice has no socket, after the older transaction began.
      const sent = await sendMessage(session.id, owner.token, {
        body: "while away",
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);

      const { socket, until } = await openReadySocket(alice.token);
      opened.push(socket);
      let done = false;
      const caughtUp = catchUp(alice.token, since, until).finally(() => {
        done = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(done).toBe(false);

      release();
      await older;
      const { events } = await caughtUp;

      expect(
        events
          .filter((e) => e.type === "message.created")
          .map((e) => e.payload.message.id)
      ).toEqual([sent.body.message.id]);
    } finally {
      release();
      await older.catch(() => {});
    }
  });
});
