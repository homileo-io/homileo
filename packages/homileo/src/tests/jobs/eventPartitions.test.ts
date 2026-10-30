// @module-tag int
// @module-tag events
// @module-tag job
import { ensureEventPartitions, utcDay } from "../../utils/partitions.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Far from any real day, so the count is exact whatever the suite did before.
const FAR_DAY = new Date(Date.UTC(2031, 2, 10));
const fixtures = chatFixtures();
const organizationId = uuidv7();

const partitionsIn = async (prefix: string) =>
  (
    await prisma.$queryRaw<Array<{ child: string }>>`
      SELECT c.relname AS child FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'chat' AND p.relname = 'events'
        AND c.relname LIKE ${prefix + "%"}
      ORDER BY c.relname`
  ).map((r) => r.child);

describe("ensureEventPartitions", () => {
  afterAll(async () => {
    await prisma.event.deleteMany({ where: { organizationId } });
    for (const name of await partitionsIn("events_2031_")) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "chat"."${name}"`);
    }
    await fixtures.cleanup();
  });

  it("creates partitions from yesterday to seven days ahead", async () => {
    const created = await ensureEventPartitions(FAR_DAY);

    expect(created).toBe(9);
    expect(await partitionsIn("events_2031_")).toEqual([
      "events_2031_03_09",
      "events_2031_03_10",
      "events_2031_03_11",
      "events_2031_03_12",
      "events_2031_03_13",
      "events_2031_03_14",
      "events_2031_03_15",
      "events_2031_03_16",
      "events_2031_03_17",
    ]);
  });

  it("is idempotent and safe to run twice at once", async () => {
    const results = await Promise.all([
      ensureEventPartitions(FAR_DAY),
      ensureEventPartitions(FAR_DAY),
    ]);

    expect(results).toEqual([9, 9]);
    expect(await partitionsIn("events_2031_")).toHaveLength(9);
  });

  it("lets a change be recorded for tomorrow", async () => {
    await ensureEventPartitions();
    const actor = await fixtures.principal();
    const tomorrow = new Date(utcDay().getTime() + MS_PER_DAY + 3_600_000);

    const row = await prisma.event.create({
      data: {
        createdAt: tomorrow,
        type: "message.created",
        organizationId,
        actorId: actor.id,
        payload: {},
      },
    });

    expect(row.createdAt).toEqual(tomorrow);
  });
});
