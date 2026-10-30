// @module-tag int
// @module-tag events
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { ValidationError } from "../../utils/errors.js";
import { recordChange } from "../../utils/changes.js";
import { prisma } from "../../utils/db/prisma.js";
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

    const event = await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "space.created",
        organizationId,
        spaceId,
        actorId: actor.id,
        entity: { type: "Space", id: spaceId },
        payload: { name: "General" },
      })
    );

    const stored = await prisma.event.findFirstOrThrow({
      where: { id: event.id },
    });
    expect(stored.type).toBe("space.created");
    expect(stored.organizationId).toBe(organizationId);
    expect(stored.actorId).toBe(actor.id);
    expect(event.payload).toEqual({ name: "General" });
    const rows = await outboxRows(organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("webhook");
    expect(rows[0].payload).toMatchObject({
      eventType: "homileo.space.created",
      organizationId,
      entityType: "Space",
      entityId: spaceId,
      data: { eventId: String(event.id), name: "General" },
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
          payload: {},
        });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await prisma.event.count({ where: { organizationId } })).toBe(0);
    expect(await outboxRows(organizationId)).toHaveLength(0);
  });

  it("writes no outbox row for a non-webhook event", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "read.updated",
        organizationId,
        actorId: actor.id,
        entity: { type: "Session", id: uuidv7() },
        payload: { seq: 3 },
      })
    );

    expect(await prisma.event.count({ where: { organizationId } })).toBe(1);
    expect(await outboxRows(organizationId)).toHaveLength(0);
  });

  it("refuses a payload its schema rejects", async () => {
    const actor = await fixtures.principal();
    const organizationId = orgId();

    await expect(
      prisma.$transaction((tx) =>
        recordChange(tx, {
          type: "space.created",
          organizationId,
          actorId: actor.id,
          entity: { type: "Space", id: uuidv7() },
          payload: "not an object",
        })
      )
    ).rejects.toBeInstanceOf(ValidationError);

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
            payload: {},
          })
        )
      )
    );

    expect(new Set(events.map((e) => e.id)).size).toBe(20);
  });
});
