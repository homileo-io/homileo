// @module-tag int
// @module-tag sync
import { EventEnvelopeSchema, SyncResponseSchema } from "@homileo-io/sdk";
import { drainSync, sync, syncHead } from "../../../support/sync.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../support/spaceApi.js";
import { sendMessage } from "../../../support/messageApi.js";
import { prisma } from "../../../../utils/db/prisma.js";
import {
  decodeSyncCursor,
  encodeSyncCursor,
} from "../../../../realtime/syncCursor.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let org = "";
let alice: Awaited<ReturnType<typeof api.actor>>;
let bob: Awaited<ReturnType<typeof api.actor>>;

/** A space-less group with alice and bob in it. */
const groupOfTwo = async () => {
  const session = await fixtures.session({ org, createdBy: alice.principal });
  await fixtures.participant(session, alice.principal, "owner");
  await fixtures.participant(session, bob.principal);
  return session;
};

beforeAll(async () => {
  org = api.organization();
  alice = await api.actor(org);
  bob = await api.actor(org);
});

afterAll(async () => {
  await api.cleanup();
});

describe("GET /v1/sync", () => {
  it("returns the head and no events without since", async () => {
    const { status, body } = await sync(bob.token);

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(decodeSyncCursor(body.next).id).toBe(0n);
    expect(SyncResponseSchema.safeParse(body).success).toBe(true);
  });

  it("returns message.created after a send, with the events row's id", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const sent = await sendMessage(session.id, alice.token, { body: "hi" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const { status, body } = await sync(bob.token, { since });

    expect(status).toBe(200);
    expect(SyncResponseSchema.safeParse(body).success).toBe(true);
    const row = await prisma.event.findFirstOrThrow({
      where: { organizationId: org, sessionId: session.id },
    });
    expect(body.events).toEqual([
      {
        id: String(row.id),
        type: "message.created",
        createdAt: row.createdAt.toISOString(),
        organizationId: org,
        spaceId: null,
        sessionId: session.id,
        actorId: alice.principal.id,
        payload: { message: sent.body.message },
      },
    ]);
    expect(EventEnvelopeSchema.safeParse(body.events[0]).success).toBe(true);
    expect(body.hasMore).toBe(false);
  });

  it("pages with hasMore: limit 1 over three events is true, true, false", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const sent: string[] = [];
    for (const text of ["one", "two", "three"]) {
      const r = await sendMessage(session.id, alice.token, { body: text });
      sent.push(r.body.message.id);
    }

    const pages = [];
    let next = since;
    for (let i = 0; i < 3; i++) {
      const { status, body } = await sync(bob.token, {
        since: next,
        limit: "1",
      });
      expect(status).toBe(200);
      pages.push(body);
      next = body.next;
    }

    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    expect(pages.map((p) => p.events[0].payload.message.id)).toEqual(sent);
  });

  it("returns nothing more from the last next", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    await sendMessage(session.id, alice.token, { body: "once" });
    const first = await drainSync(bob.token, since);

    const again = await drainSync(bob.token, first.next);

    expect(first.events).toHaveLength(1);
    expect(again.events).toEqual([]);
  });

  it("answers 410 resync_required to a cursor older than the oldest retained day", async () => {
    // The test database's oldest partition starts yesterday.
    const head = decodeSyncCursor(await syncHead(bob.token));
    const since = encodeSyncCursor({
      ...head,
      at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });

    const { status, body } = await sync(bob.token, { since });

    expect(status).toBe(410);
    expect(body.error).toBe("resync_required");
  });

  it("answers 400 invalid_request to an until this database has not reached", async () => {
    const since = await syncHead(bob.token);
    const head = decodeSyncCursor(since);
    const until = encodeSyncCursor({ ...head, txId: head.txId + 10n ** 12n });

    const { status, body } = await sync(bob.token, { since, until });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("until");
  });

  it("answers hasMore false once the horizon has passed until", async () => {
    const since = await syncHead(bob.token);

    const { status, body } = await sync(bob.token, { since, until: since });

    expect(status).toBe(200);
    expect(body.hasMore).toBe(false);
  });

  it("answers 400 invalid_request to a malformed cursor", async () => {
    const { status, body } = await sync(bob.token, { since: "not-a-cursor" });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("validates the query with the route's schema", async () => {
    const { status, body } = await sync(bob.token, { limit: "501" });

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0].path).toBe("limit");
  });
});
