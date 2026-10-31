import type { Event } from "../../../prisma/generated/client/index.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import type { SyncPosition } from "../../realtime/syncCursor.js";
import { pgErrorCodes } from "../prismaErrors.js";
import type { ChangeEvent } from "../changes.js";
import { prisma } from "./prisma.js";
import env from "../../env.js";

export type { Event };

export interface InsertEventInput {
  type: string;
  organizationId: string;
  spaceId: string | null;
  sessionId: string | null;
  actorId: string;
  payload: Prisma.InputJsonValue;
}

/**
 * `txId` is the writing transaction's id, which orders the log for /sync. The
 * row's own `tx_id` is `xid8`, which Prisma cannot read, so it is not on
 * `Event`.
 */
export type EventRow = ChangeEvent & { txId: bigint };

/** Appends to the log inside the caller's transaction. */
export const insert = (
  tx: Prisma.TransactionClient,
  input: InsertEventInput
): Promise<Event> => tx.event.create({ data: input });

// A lock not granted in time, and a deadlock: Postgres has rolled the
// transaction back either way and the next run retries.
const RETRY_LATER = ["55P03", "40P01"];

const PARTITION_NAME = /^events_\d{4}_\d{2}_\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creating a partition takes ACCESS EXCLUSIVE on `chat.events`. Left to wait
 * behind a long read it would queue every insert behind itself, so it gives up
 * after PARTITION_DDL_LOCK_TIMEOUT_MS. False, with nothing created, when it did.
 */
export const createPartition = async (
  name: string,
  from: string,
  to: string
): Promise<boolean> => {
  // The names are interpolated into DDL, which takes no parameters.
  if (!PARTITION_NAME.test(name) || !DATE.test(from) || !DATE.test(to)) {
    throw new Error(`Invalid partition ${name} [${from}, ${to})`);
  }
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${env.PARTITION_DDL_LOCK_TIMEOUT_MS}`
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "chat"."${name}" PARTITION OF "chat"."events" FOR VALUES FROM ('${from}') TO ('${to}')`
        );
      },
      { timeout: 60_000 }
    );
    return true;
  } catch (err) {
    if (pgErrorCodes(err).some((code) => RETRY_LATER.includes(code))) {
      return false;
    }
    throw err;
  }
};

interface RawEventRow {
  id: bigint;
  created_at: Date;
  type: ChangeEvent["type"];
  organization_id: string;
  space_id: string | null;
  session_id: string | null;
  actor_id: string;
  payload: unknown;
  tx_id: string;
}

const toEventRow = (r: RawEventRow): EventRow => ({
  id: r.id,
  createdAt: r.created_at,
  type: r.type,
  organizationId: r.organization_id,
  spaceId: r.space_id,
  sessionId: r.session_id,
  actorId: r.actor_id,
  payload: r.payload,
  txId: BigInt(r.tx_id),
});

/**
 * Where a reader that starts now begins: the oldest running transaction. Every
 * event it has not yet committed has a higher id, so nothing is skipped.
 */
export const head = async (): Promise<SyncPosition> => {
  const [row] = await prisma.$queryRaw<Array<{ tx_id: string; at: Date }>>`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS tx_id,
           date_trunc('milliseconds', now() AT TIME ZONE 'UTC') AS at`;
  return { txId: BigInt(row.tx_id), id: 0n, at: row.at };
};

/**
 * Events after `after` in commit order, matching `where` (SQL over the
 * `chat.events` columns). Only transactions older than every running one are
 * read, so a transaction that commits later can never land behind the cursor.
 */
export const readFrom = async (
  after: SyncPosition,
  where: Prisma.Sql,
  limit: number
): Promise<{ rows: EventRow[]; next: SyncPosition; hasMore: boolean }> => {
  // `at` rides in the same statement as the rows; the join keeps one row
  // when the page is empty.
  const found = await prisma.$queryRaw<
    Array<Partial<RawEventRow> & { at: Date }>
  >`
    SELECT date_trunc('milliseconds', now() AT TIME ZONE 'UTC') AS at,
           page.id, page.created_at, page.type, page.organization_id,
           page.space_id, page.session_id, page.actor_id, page.payload,
           page.tx_id::text AS tx_id
    FROM (SELECT 1) AS one
    LEFT JOIN (
      -- Native xid8 and bigint, so both sorts are numeric.
      SELECT id, created_at, type, organization_id, space_id, session_id,
             actor_id, payload, tx_id
      FROM "chat"."events"
      WHERE (tx_id, id) > (${after.txId.toString()}::xid8, ${after.id})
        AND tx_id < pg_snapshot_xmin(pg_current_snapshot())
        AND (${where})
      ORDER BY tx_id, id
      LIMIT ${limit + 1}
    ) AS page ON true
    ORDER BY page.tx_id, page.id`;
  const now = found[0].at;
  const matched = found.filter((r) => r.id != null) as RawEventRow[];
  const hasMore = matched.length > limit;
  const rows = matched.slice(0, limit).map(toEventRow);
  const last = rows.at(-1);
  // Until the page drains to the horizon, what is left may be committed
  // backlog of any age, so the cursor keeps the time it was issued: a
  // retention drop in between must still read as too old.
  const at = hasMore ? after.at : now;
  return {
    rows,
    next: last ? { txId: last.txId, id: last.id, at } : { ...after, at },
    hasMore,
  };
};

export interface Partition {
  name: string;
  /** Inclusive lower bound, midnight UTC. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

const BOUNDS =
  /FROM \('(\d{4}-\d{2}-\d{2})[^']*'\) TO \('(\d{4}-\d{2}-\d{2})[^']*'\)/;

/** The daily partitions of `chat.events`, oldest first. */
export const listPartitions = async (): Promise<Partition[]> => {
  const rows = await prisma.$queryRaw<Array<{ name: string; bound: string }>>`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'chat' AND p.relname = 'events'
    ORDER BY c.relname`;
  return rows.flatMap((r) => {
    const m = BOUNDS.exec(r.bound);
    if (!m || !PARTITION_NAME.test(r.name)) return [];
    return [{ name: r.name, from: new Date(m[1]), to: new Date(m[2]) }];
  });
};

/** The lower bound of the oldest `events_*` partition, null with none. */
export const oldestRetainedDay = async (): Promise<Date | null> => {
  const partitions = await listPartitions();
  return partitions.reduce<Date | null>(
    (oldest, p) => (oldest && oldest <= p.from ? oldest : p.from),
    null
  );
};

/**
 * Detaches and drops a partition, under the same lock timeout as
 * `createPartition`. False, with nothing dropped, when the lock was not granted.
 */
export const dropPartition = async (name: string): Promise<boolean> => {
  if (!PARTITION_NAME.test(name)) throw new Error(`Invalid partition ${name}`);
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${env.PARTITION_DDL_LOCK_TIMEOUT_MS}`
        );
        await tx.$executeRawUnsafe(
          `ALTER TABLE "chat"."events" DETACH PARTITION "chat"."${name}"`
        );
        await tx.$executeRawUnsafe(`DROP TABLE "chat"."${name}"`);
      },
      { timeout: 60_000 }
    );
    return true;
  } catch (err) {
    if (pgErrorCodes(err).some((code) => RETRY_LATER.includes(code))) {
      return false;
    }
    // Another replica's run dropped it first.
    if (pgErrorCodes(err).includes("42P01")) return true;
    throw err;
  }
};
