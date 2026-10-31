// @module-tag int
// @module-tag events
// @module-tag job
import { processEventRetention } from "../../jobs/eventRetention.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPartition } from "../../utils/db/events.js";
import { prisma } from "../../utils/db/prisma.js";
import { db } from "../../utils/db/index.js";
import env from "../../env.js";
import {
  dropExpiredPartitions,
  ensureEventPartitions,
  partitionName,
  utcDay,
} from "../../utils/partitions.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Years before any partition the suite makes, so only these are ever expired.
const TODAY = new Date(Date.UTC(2020, 5, 15));
const day = (offset: number) => new Date(TODAY.getTime() + offset * MS_PER_DAY);
const iso = (d: Date) => d.toISOString().split("T")[0];

const remaining = async () =>
  (
    await prisma.$queryRaw<Array<{ child: string }>>`
      SELECT c.relname AS child FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'chat' AND p.relname = 'events'
        AND c.relname LIKE 'events_2020_%'
      ORDER BY c.relname`
  ).map((r) => r.child);

describe("dropExpiredPartitions", () => {
  beforeAll(async () => {
    for (let i = -40; i <= 7; i++) {
      const d = day(i);
      await createPartition(
        partitionName(d),
        iso(d),
        iso(new Date(d.getTime() + MS_PER_DAY))
      );
    }
  });
  afterAll(async () => {
    for (const name of await remaining()) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "chat"."${name}"`);
    }
  });

  it("finds the oldest retained day", async () => {
    expect(await db.events.oldestRetainedDay()).toEqual(day(-40));
  });

  it("drops partitions that ended on or before today minus the retention and keeps the rest", async () => {
    const dropped = await dropExpiredPartitions(TODAY, 30);

    expect(dropped).toEqual(
      Array.from({ length: 10 }, (_, i) => partitionName(day(-40 + i)))
    );
    const left = await remaining();
    expect(left).toHaveLength(38);
    expect(left[0]).toBe(partitionName(day(-30)));
    expect(left.at(-1)).toBe(partitionName(day(7)));
    expect(await db.events.oldestRetainedDay()).toEqual(day(-30));
  });

  it("runs safely twice", async () => {
    expect(await dropExpiredPartitions(TODAY, 30)).toEqual([]);
    expect(await remaining()).toHaveLength(38);
  });

  it("treats a partition another replica already dropped as dropped", async () => {
    await expect(db.events.dropPartition("events_2020_01_01")).resolves.toBe(
      true
    );
  });

  it("drops a partition that holds rows", async () => {
    const d = day(-35);
    await createPartition(
      partitionName(d),
      iso(d),
      iso(new Date(d.getTime() + MS_PER_DAY))
    );
    await prisma.event.create({
      data: {
        createdAt: new Date(d.getTime() + 3_600_000),
        type: "message.created",
        organizationId: "00000000-0000-7000-8000-0000000000aa",
        payload: {},
      },
    });

    expect(await dropExpiredPartitions(TODAY, 30)).toEqual([partitionName(d)]);
  });
});

describe("processEventRetention", () => {
  it("expires partitions older than EVENT_RETENTION_DAYS and keeps today's", async () => {
    const old = new Date(
      utcDay().getTime() - (env.EVENT_RETENTION_DAYS + 3) * MS_PER_DAY
    );
    await createPartition(
      partitionName(old),
      iso(old),
      iso(new Date(old.getTime() + MS_PER_DAY))
    );
    await ensureEventPartitions();

    const dropped = await processEventRetention();

    expect(dropped).toContain(partitionName(old));
    expect((await db.events.listPartitions()).map((p) => p.name)).toContain(
      partitionName(utcDay())
    );
  });
});
