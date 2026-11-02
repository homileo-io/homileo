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

/**
 * Appends `inputs` to the log in one statement inside the caller's
 * transaction, returning each row's id and time in the order of `inputs`.
 */
export const insertMany = async (
  tx: Prisma.TransactionClient,
  inputs: InsertEventInput[]
): Promise<Array<{ id: bigint; createdAt: Date }>> => {
  if (inputs.length === 0) return [];
  const column = <K extends keyof InsertEventInput>(key: K) =>
    inputs.map((input) => input[key]);
  const rows = await tx.$queryRaw<Array<{ id: bigint; created_at: Date }>>`
    INSERT INTO "chat"."events"
      (type, organization_id, space_id, session_id, actor_id, payload)
    SELECT t.type, t.organization_id::uuid, t.space_id::uuid,
           t.session_id::uuid, t.actor_id::uuid, t.payload::jsonb
    FROM unnest(${column("type")}::text[], ${column("organizationId")}::text[],
                ${column("spaceId")}::text[], ${column("sessionId")}::text[],
                ${column("actorId")}::text[],
                ${inputs.map((input) => JSON.stringify(input.payload))}::text[])
      WITH ORDINALITY AS t(type, organization_id, space_id, session_id, actor_id, payload, n)
    ORDER BY t.n
    RETURNING id, created_at`;
  // The identity is drawn as rows are inserted, in `n` order, so id order is
  // input order; RETURNING's own order is not promised.
  return rows
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({ id: row.id, createdAt: row.created_at }));
};

export const insert = async (
  tx: Prisma.TransactionClient,
  input: InsertEventInput
): Promise<{ id: bigint; createdAt: Date }> =>
  (await insertMany(tx, [input]))[0];

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
 * The first transaction id not yet assigned: every transaction at or above it
 * starts after this call. A socket takes it once its rooms are joined, so
 * those transactions' fan-out reaches it, and its catch-up runs until the
 * horizon passes it.
 */
export const tail = async (): Promise<SyncPosition> => {
  const [row] = await prisma.$queryRaw<Array<{ tx_id: string; at: Date }>>`
    SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS tx_id,
           date_trunc('milliseconds', now() AT TIME ZONE 'UTC') AS at`;
  return { txId: BigInt(row.tx_id), id: 0n, at: row.at };
};

/** The alias `readFrom` gives `chat.events`; its `where` may qualify columns with it. */
export const EVENTS_ALIAS = "ev";

/** The most rows one `readFrom` page scans, matching or not. */
export const MAX_SCANNED_ROWS = 5000;

/**
 * Events after `after` in commit order, matching `where`: SQL over the
 * `chat.events` columns, unqualified or qualified as `ev` (`EVENTS_ALIAS`),
 * which a correlated subquery in it must use. Only transactions older than
 * every running one are read, so a transaction that commits later can never
 * land behind the cursor. At most `maxScanned` rows within `scope` are
 * scanned per page: `where` must imply it, and an index should lead with it.
 * A page cut there has more, and its cursor is the last row scanned.
 */
export const readFrom = async (
  after: SyncPosition,
  where: Prisma.Sql,
  limit: number,
  o: { scope?: Prisma.Sql; maxScanned?: number } = {}
): Promise<{
  rows: EventRow[];
  next: SyncPosition;
  hasMore: boolean;
  /** The horizon read up to: every transaction below it had ended. */
  horizon: bigint;
  /** The first transaction id not yet assigned when the page was read. */
  tail: bigint;
}> => {
  const scope = o.scope ?? Prisma.sql`true`;
  const maxScanned = o.maxScanned ?? MAX_SCANNED_ROWS;
  const alias = Prisma.raw(EVENTS_ALIAS);
  // `at` and the horizon ride in the same statement as the rows; the joins
  // keep one row when the page is empty.
  const found = await prisma.$queryRaw<
    Array<
      Partial<RawEventRow> & {
        at: Date;
        horizon: string;
        tail: string;
        scanned: number | null;
        scanned_tx_id: string | null;
        scanned_id: bigint | null;
      }
    >
  >`
    WITH scanned AS MATERIALIZED (
      -- Native xid8 and bigint, so both sorts are numeric.
      SELECT id, created_at, type, organization_id, space_id, session_id,
             actor_id, payload, tx_id
      FROM "chat"."events"
      WHERE (tx_id, id) > (${after.txId.toString()}::xid8, ${after.id})
        AND tx_id < pg_snapshot_xmin(pg_current_snapshot())
        AND (${scope})
      ORDER BY tx_id, id
      LIMIT ${maxScanned}
    ), last_scanned AS (
      SELECT tx_id::text AS tx_id, id, (count(*) OVER ())::int AS n
      FROM scanned
      ORDER BY tx_id DESC, id DESC
      LIMIT 1
    )
    SELECT date_trunc('milliseconds', now() AT TIME ZONE 'UTC') AS at,
           pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
           pg_snapshot_xmax(pg_current_snapshot())::text AS tail,
           ls.n AS scanned, ls.tx_id AS scanned_tx_id, ls.id AS scanned_id,
           page.id, page.created_at, page.type, page.organization_id,
           page.space_id, page.session_id, page.actor_id, page.payload,
           page.tx_id::text AS tx_id
    FROM (SELECT 1) AS one
    LEFT JOIN last_scanned AS ls ON true
    LEFT JOIN (
      SELECT id, created_at, type, organization_id, space_id, session_id,
             actor_id, payload, tx_id
      FROM scanned AS ${alias}
      WHERE (${where})
      ORDER BY tx_id, id
      LIMIT ${limit + 1}
    ) AS page ON true
    ORDER BY page.tx_id, page.id`;
  const first = found[0];
  const now = first.at;
  const horizon = BigInt(first.horizon);
  const tail = BigInt(first.tail);
  const matched = found.filter((r) => r.id != null) as RawEventRow[];
  const rows = matched.slice(0, limit).map(toEventRow);
  const last = rows.at(-1);
  // What is left may be committed backlog of any age, so a cursor with more
  // keeps the time it was issued: a retention drop in between must still read
  // as too old.
  if (matched.length > limit) {
    return {
      rows,
      next: { txId: last!.txId, id: last!.id, at: after.at },
      hasMore: true,
      horizon,
      tail,
    };
  }
  // Every scanned row was matched against `where`, so the next page starts
  // after the last one scanned.
  if ((first.scanned ?? 0) >= maxScanned) {
    return {
      rows,
      next: {
        txId: BigInt(first.scanned_tx_id!),
        id: BigInt(first.scanned_id!),
        at: after.at,
      },
      hasMore: true,
      horizon,
      tail,
    };
  }
  // Every row below the horizon was scanned, matching or not, so the next
  // read starts there rather than rescanning them.
  const reached = last ?? after;
  const next =
    horizon > reached.txId
      ? { txId: horizon, id: 0n, at: now }
      : { txId: reached.txId, id: reached.id, at: now };
  return { rows, next, hasMore: false, horizon, tail };
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
