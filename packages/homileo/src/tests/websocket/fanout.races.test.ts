// @module-tag int
// @module-tag websocket
// @module-tag race
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChangeEvent } from "../../utils/changes.js";
import { spaceApiFixtures } from "../support/spaceApi.js";
import { sendMessage } from "../support/messageApi.js";
import type { JsonResponse } from "../support/http.js";
import { changeBus } from "../../utils/changeBus.js";
import { startV1App } from "../support/v1App.js";
import {
  collect,
  eventually,
  openLocalSocket,
  request,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let app: Awaited<ReturnType<typeof startV1App>>;
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

beforeAll(async () => {
  app = await startV1App();
  local = await startSocketServer({ fanout: true });
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await local.close();
  await app.close();
  await api.cleanup();
});

describe("startFanout ordering", () => {
  it("delivers 20 concurrent sends to a subscriber in the order this node committed them, without repeats", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const watcher = await api.actor(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.member(space, owner.principal, "owner");
    await fixtures.participant(session, owner.principal, "owner");
    const socket = await openLocalSocket(watcher.token, local);
    opened.push(socket);
    expect(
      await request(socket, "subscribe", { sessionId: session.id })
    ).toEqual({ ok: true });
    const received = collect<JsonResponse["body"]>(socket, "message.created");
    const committed: string[] = [];
    const onCommitted = (events: ChangeEvent[]) => {
      for (const e of events) {
        if (e.type === "message.created" && e.sessionId === session.id) {
          committed.push(e.id.toString());
        }
      }
    };
    changeBus.on("committed", onCommitted);

    try {
      const sends = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          sendMessage(session.id, owner.token, { body: `m${i}` }, app.url)
        )
      );
      for (const res of sends) expect(res.status).toBe(201);
      await eventually(() => received.length >= 20, 5000);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      changeBus.off("committed", onCommitted);
    }

    const ids = received.map((e) => e.id as string);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(ids).toEqual(committed);
  });
});
