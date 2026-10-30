// @module-tag int
// @module-tag events
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { recordChange } from "../../utils/changes.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const organizationId = uuidv7();
const otherOrganizationId = uuidv7();

describe("recordChange audit", () => {
  beforeAll(async () => {
    await initializeTereo();
  });

  afterAll(async () => {
    for (const id of [organizationId, otherOrganizationId]) {
      await prisma.event.deleteMany({ where: { organizationId: id } });
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${id}`;
    }
    await fixtures.cleanup();
    await stopTereo();
  });

  it("adds an audit outbox row when audit is given", async () => {
    const actor = await fixtures.principal();
    const entityId = uuidv7();
    const userId = uuidv7();

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "space.archived",
        organizationId,
        actorId: actor.id,
        entity: { type: "Space", id: entityId },
        payload: {},
        audit: { action: "UPDATE", userId, metadata: { reason: "test" } },
      })
    );

    const rows = await prisma.$queryRaw<
      Array<{ destination: string; payload: Record<string, unknown> }>
    >`SELECT destination, payload FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${organizationId}
        AND destination = 'audit'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      action: "UPDATE",
      entityType: "Space",
      entityId,
      userId,
      organizationId,
      metadata: { reason: "test" },
    });
  });

  it("adds no audit row when audit is omitted", async () => {
    const actor = await fixtures.principal();

    await prisma.$transaction((tx) =>
      recordChange(tx, {
        type: "space.archived",
        organizationId: otherOrganizationId,
        actorId: actor.id,
        entity: { type: "Space", id: uuidv7() },
        payload: {},
      })
    );

    const rows = await prisma.$queryRaw<Array<{ destination: string }>>`
      SELECT destination FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${otherOrganizationId}`;
    expect(rows.map((r) => r.destination)).toEqual(["webhook"]);
  });
});
