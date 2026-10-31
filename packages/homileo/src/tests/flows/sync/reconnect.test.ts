// @module-tag int
// @module-tag sync
// @module-tag websocket
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../support/spaceApi.js";
import { drainSync, syncHead } from "../../support/sync.js";
import { sendMessage } from "../../support/messageApi.js";
import type { JsonResponse } from "../../support/http.js";
import {
  collect,
  eventually,
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
  it("recovers every message in commit order from the socket's events and a replay from the first cursor", async () => {
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

    const again = await openSocket(alice.token);
    opened.push(again);
    const { events } = await drainSync(alice.token, first);

    const seen = new Set<string>();
    const applied = [...live, ...events].filter((e) => {
      if (e.type !== "message.created" || seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
    expect(applied.map((e) => e.payload.message.id)).toEqual(sentIds);
    expect(applied.map((e) => BigInt(e.id))).toEqual(
      events
        .filter((e) => e.type === "message.created")
        .map((e) => BigInt(e.id))
    );
  });
});
