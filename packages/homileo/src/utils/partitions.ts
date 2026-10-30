import { createPartition } from "./db/events.js";
import { pgErrorCodes } from "./prismaErrors.js";
import { logger } from "./logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FUTURE_DAYS = 7;

/** Midnight UTC of `now`'s day. Partition bounds and names are UTC dates. */
export const utcDay = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const dateStr = (d: Date) => d.toISOString().split("T")[0];

export const partitionName = (day: Date): string =>
  `events_${dateStr(day).replaceAll("-", "_")}`;

/**
 * Two processes creating the same partition at once can both pass `IF NOT
 * EXISTS`; the loser then fails on the catalog's unique index — 23505 on
 * `pg_type`, or 42P07 when the relation is already visible.
 */
const isConcurrentCreate = (err: unknown): boolean => {
  const codes = pgErrorCodes(err);
  if (codes.includes("42P07") || codes.includes("23505")) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|pg_type_typname_nsp_index/.test(message);
};

/**
 * Daily partitions of `chat.events` from yesterday through a week ahead
 * (UTC, relative to `today`). Idempotent, and safe to run from several
 * processes at once. Stops at the first day whose table stayed locked and
 * returns how many days were ensured before it.
 */
export async function ensureEventPartitions(
  today: Date = utcDay()
): Promise<number> {
  const start = utcDay(today);
  let ensured = 0;
  for (let i = -1; i <= FUTURE_DAYS; i++) {
    const day = new Date(start.getTime() + i * MS_PER_DAY);
    const next = new Date(day.getTime() + MS_PER_DAY);
    const name = partitionName(day);
    let created: boolean;
    try {
      created = await createPartition(name, dateStr(day), dateStr(next));
    } catch (err) {
      if (!isConcurrentCreate(err)) throw err;
      logger.debug({ partition: name }, "Partition created concurrently");
      created = true;
    }
    if (!created) {
      // The later days would only wait out the same lock.
      logger.warn(
        { partition: name },
        "Events table locked; creating the partition next run"
      );
      break;
    }
    ensured++;
  }
  return ensured;
}
