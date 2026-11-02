// @module-tag int
// @module-tag events
import { readPayload, spacePayload } from "../support/eventPayloads.js";
import { recordChange, recordChanges } from "../../utils/changes.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { prisma } from "../../utils/db/prisma.js";
import { AppError } from "../../utils/errors.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const organizationIds: string[] = [];

const orgId = () => {
  const id = uuidv7();
  organizationIds.push(id);
  return id;
};

const outboxRows = (organizationId: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`
    SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${organizationId}`;

describe("recordChange", () => {
  beforeAll(async () => {
    await initializeTereo();
  });

  afterAll(async () => {
    await prisma.event.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    for (const id of organizationIds) {
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${id}`;
    }
    await fixtures.cleanup();
    await stopTereo();
  });

  it("writes the event and an outbox webhook row in the caller's transaction", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();
    const spaceId = uuidv7();
    const payload = spacePayload(spaceId);

    const event = await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "space.created",
        organizationId,
        spaceId,
        actorId: actor.id,
        entity: { type: "Space", id: spaceId },
        payload,
      })
    );

    const stored = await prisma.event.findFirstOrThrow({
      where: { id: event.id },
    });
    expect(stored.type).toBe("space.created");
    expect(stored.organizationId).toBe(organizationId);
    expect(stored.actorId).toBe(actor.id);
    expect(event.payload).toEqual(payload);
    const rows = await outboxRows(organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("webhook");
    expect(rows[0].payload).toMatchObject({
      eventType: "homileo.space.created",
      organizationId,
      entityType: "Space",
      entityId: spaceId,
      data: { eventId: String(event.id), ...payload },
    });
  });

  it("puts the real event id in the webhook data", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();
    const spaceId = uuidv7();

    const event = await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "space.created",
        organizationId,
        spaceId,
        actorId: actor.id,
        entity: { type: "Space", id: spaceId },
        payload: spacePayload(spaceId),
      })
    );

    const rows = await outboxRows(organizationId);
    expect(rows[0].payload).toMatchObject({
      data: { eventId: String(event.id) },
    });
  });

  it("writes neither when the transaction rolls back", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    await expect(
      prisma.$transaction(async (tx) => {
        await recordChange(tx, {
          type: "space.created",
          organizationId,
          actorId: actor.id,
          entity: { type: "Space", id: uuidv7() },
          payload: spacePayload(),
        });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await prisma.event.count({ where: { organizationId } })).toBe(0);
    expect(await outboxRows(organizationId)).toHaveLength(0);
  });

  it.each([
    [
      "a space session with access space",
      "space",
      "space",
      "homileo.reaction.added",
    ],
    [
      "a space session with access members",
      "space",
      "members",
      "homileo.private_reaction.added",
    ],
    [
      "a space-less session",
      "none",
      "members",
      "homileo.private_reaction.added",
    ],
  ] as const)(
    "names the webhook of %s",
    async (_label, where, access, eventType) => {
      const actor = await fixtures.principal();
      const organizationId = orgId();
      const space =
        where === "space"
          ? await fixtures.space({ org: organizationId })
          : undefined;
      const session = await fixtures.session({
        org: organizationId,
        space,
        access,
      });

      await prisma.$transaction((tx) =>
        recordChange(tx, {
          type: "reaction.added",
          organizationId,
          spaceId: space?.id ?? null,
          sessionId: session.id,
          actorId: actor.id,
          entity: { type: "message", id: uuidv7() },
          payload: {
            sessionId: session.id,
            messageId: uuidv7(),
            principalId: actor.id,
            emoji: "👍",
            reactions: [],
            reactionSeq: 1,
          },
        })
      );

      const rows = await outboxRows(organizationId);
      expect(rows.map((r) => r.payload.eventType)).toEqual([eventType]);
    }
  );

  it("writes no outbox row for a non-webhook event", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "read.updated",
        organizationId,
        actorId: actor.id,
        entity: { type: "Session", id: uuidv7() },
        payload: readPayload(),
      })
    );

    expect(await prisma.event.count({ where: { organizationId } })).toBe(1);
    expect(await outboxRows(organizationId)).toHaveLength(0);
  });

  it("refuses a payload its schema rejects as a server error, not the caller's", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    const failure = await prisma
      .$transaction((tx) =>
        recordChange(tx, {
          type: "space.created",
          organizationId,
          actorId: actor.id,
          entity: { type: "Space", id: uuidv7() },
          payload: "not an object",
        })
      )
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AppError);
    expect((failure as Error).message).toMatch(/space\.created/);

    expect(await prisma.event.count({ where: { organizationId } })).toBe(0);
    expect(await outboxRows(organizationId)).toHaveLength(0);
  });

  it("assigns increasing ids across concurrent transactions", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    const events = await Promise.all(
      Array.from({ length: 20 }, () =>
        prisma.$transaction((tx) =>
          recordChange(tx, {
            type: "read.updated",
            organizationId,
            actorId: actor.id,
            entity: { type: "Session", id: uuidv7() },
            payload: readPayload(),
          })
        )
      )
    );

    expect(new Set(events.map((e) => e.id)).size).toBe(20);
  });
  it("records a batch in the order given, each webhook under its own session's name", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();
    const space = await fixtures.space({ org: organizationId });
    const open = await fixtures.session({ org: organizationId, space });
    const closed = await fixtures.session({
      org: organizationId,
      space,
      access: "members",
    });
    const removed = (sessionId: string) => ({
      type: "session.participant_removed" as const,
      organizationId,
      spaceId: space.id,
      sessionId,
      actorId: actor.id,
      entity: { type: "session", id: sessionId },
      payload: { sessionId, principalId: actor.id },
    });

    const events = await prisma.$transaction((tx) =>
      recordChanges(tx, [
        removed(open.id),
        {
          type: "read.updated",
          organizationId,
          actorId: actor.id,
          entity: { type: "Session", id: open.id },
          payload: readPayload(),
        },
        {
          ...removed(closed.id),
          audit: { action: "DELETE", userId: uuidv7() },
        },
      ])
    );

    expect(events.map((e) => e.type)).toEqual([
      "session.participant_removed",
      "read.updated",
      "session.participant_removed",
    ]);
    expect(events[0].id < events[1].id && events[1].id < events[2].id).toBe(
      true
    );
    const stored = await prisma.event.findMany({
      where: { organizationId },
      orderBy: { id: "asc" },
    });
    expect(stored.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(stored.map((e) => e.sessionId)).toEqual([open.id, null, closed.id]);
    const rows = await prisma.$queryRaw<
      Array<{ destination: string; payload: Record<string, unknown> }>
    >`
      SELECT destination, payload FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${organizationId} ORDER BY id`;
    expect(
      rows.map((r) => [r.destination, r.payload.eventType ?? r.payload.action])
    ).toEqual([
      ["webhook", "homileo.session.participant_removed"],
      ["webhook", "homileo.private_session.participant_removed"],
      ["audit", "DELETE"],
    ]);
    expect(rows[1].payload).toMatchObject({
      data: { eventId: String(events[2].id) },
    });
  });

  it("validates every payload of a batch before it sends any statement", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();
    const valid = {
      type: "read.updated" as const,
      organizationId,
      actorId: actor.id,
      entity: { type: "Session", id: uuidv7() },
      payload: readPayload(),
    };
    const sent: string[] = [];
    // Records every raw statement the batch reaches for, so a write before the bad payload shows.
    const watch = (tx: Parameters<typeof recordChanges>[0]) =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && prop.startsWith("$")) sent.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      });

    await expect(
      prisma.$transaction((tx) =>
        recordChanges(watch(tx), [
          valid,
          valid,
          { ...valid, payload: "not an object" },
        ])
      )
    ).rejects.toThrow(/read\.updated/);

    expect(sent).toEqual([]);
    expect(await prisma.event.count({ where: { organizationId } })).toBe(0);
    expect(await outboxRows(organizationId)).toEqual([]);
    // The watch does see a batch's statements.
    await prisma.$transaction((tx) => recordChanges(watch(tx), [valid]));
    expect(sent).toContain("$queryRaw");
  });
});
