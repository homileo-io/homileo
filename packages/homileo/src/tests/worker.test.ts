// @module-tag int
// @module-tag platform
// @module-tag job
import { afterEach, describe, expect, it, vi } from "vitest";
import { partitionName } from "../utils/partitions.js";
import { startWorker, stopWorker } from "../worker.js";
import { prisma } from "../utils/db/prisma.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Far from any real day, so the partitions the worker creates are ours to drop.
const START = new Date(Date.UTC(2032, 4, 10, 12));

const partitionExists = async (name: string) =>
  (
    await prisma.$queryRaw<Array<{ found: boolean }>>`
      SELECT to_regclass(${`chat.${name}`}) IS NOT NULL AS found`
  )[0].found;

const dropPartitionsOf2032 = async () => {
  const rows = await prisma.$queryRaw<Array<{ child: string }>>`
    SELECT c.relname AS child FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'chat' AND p.relname = 'events'
      AND c.relname LIKE 'events_2032_%'`;
  for (const { child } of rows) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "chat"."${child}"`);
  }
};

describe("worker", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await stopWorker();
    await dropPartitionsOf2032();
  });

  it("ensures event partitions on start and daily", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      now: START,
    });

    await startWorker();

    expect(
      await partitionExists(
        partitionName(new Date(START.getTime() + 7 * MS_PER_DAY))
      )
    ).toBe(true);
    const dayEight = partitionName(new Date(START.getTime() + 8 * MS_PER_DAY));
    expect(await partitionExists(dayEight)).toBe(false);

    await vi.advanceTimersByTimeAsync(MS_PER_DAY);
    await vi.waitFor(async () => {
      expect(await partitionExists(dayEight)).toBe(true);
    });
  });
});
