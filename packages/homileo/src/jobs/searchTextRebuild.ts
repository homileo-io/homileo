import { prisma, type Prisma } from "../utils/db/prisma.js";
import { searchTextOf } from "../utils/searchText.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";

export const SEARCH_REBUILD_BATCH = 500;

type Tx = Prisma.TransactionClient;

interface Row {
  id: string;
  name: string | null;
  metadata: Record<string, unknown>;
}

// Raw SQL throughout: updated_at stays as it is and no event is written.
const selectSpaces = (tx: Tx, kind: string, after: string | null, n: number) =>
  tx.$queryRaw<Row[]>`
    SELECT id::text, name, metadata FROM "chat"."spaces"
    WHERE kind = ${kind} AND (${after}::uuid IS NULL OR id > ${after}::uuid)
    ORDER BY id LIMIT ${n} FOR UPDATE`;

const selectSessions = (
  tx: Tx,
  kind: string,
  after: string | null,
  n: number
) =>
  tx.$queryRaw<Row[]>`
    SELECT id::text, name, metadata FROM "chat"."sessions"
    WHERE space_id IN (SELECT id FROM "chat"."spaces" WHERE kind = ${kind})
      AND (${after}::uuid IS NULL OR id > ${after}::uuid)
    ORDER BY id LIMIT ${n} FOR UPDATE`;

const updateSpaces = (tx: Tx, ids: string[], texts: string[]) =>
  tx.$executeRaw`
    UPDATE "chat"."spaces" t SET search_text = v.text
    FROM unnest(${ids}::uuid[], ${texts}::text[]) AS v(id, text)
    WHERE t.id = v.id`;

const updateSessions = (tx: Tx, ids: string[], texts: string[]) =>
  tx.$executeRaw`
    UPDATE "chat"."sessions" t SET search_text = v.text
    FROM unnest(${ids}::uuid[], ${texts}::text[]) AS v(id, text)
    WHERE t.id = v.id`;

const tables = [
  { select: selectSpaces, update: updateSpaces },
  { select: selectSessions, update: updateSessions },
];

const rebuildKind = async (
  kind: string,
  keys: string[],
  batchSize: number
): Promise<number> => {
  let rows = 0;
  for (const { select, update } of tables) {
    let after: string | null = null;
    do {
      // Each batch is its own transaction, so a lock is held for one batch.
      // FOR UPDATE makes a concurrent write wait, and the text written is
      // computed from the row it locked.
      const ids: string[] = await prisma.$transaction(
        async (tx) => {
          const batch = await select(tx, kind, after, batchSize);
          if (batch.length > 0) {
            await update(
              tx,
              batch.map((r) => r.id),
              batch.map((r) => searchTextOf(r.name, r.metadata, keys))
            );
          }
          return batch.map((r) => r.id);
        },
        { timeout: env.DB_TRANSACTION_TIMEOUT_MS }
      );
      rows += ids.length;
      after = ids.length < batchSize ? null : ids[ids.length - 1];
    } while (after !== null);
  }
  return rows;
};

/**
 * Rebuilds `search_text` of the spaces and sessions of every kind whose search
 * keys changed (`search_changed_at`) and have not been built since. The stamp
 * read before the walk is compared when it ends: a change during the walk
 * leaves the kind due, so the next run builds it again.
 */
export const processSearchTextRebuild = async (
  opts: { batchSize?: number; settleMs?: number } = {}
): Promise<{ kinds: string[]; rows: number }> => {
  const batchSize = opts.batchSize ?? SEARCH_REBUILD_BATCH;
  const settleMs = opts.settleMs ?? env.DB_TRANSACTION_TIMEOUT_MS;
  // Past the settle time no apply transaction that stamped it is still open
  // to write spaces under the old keys.
  const due = await prisma.$queryRaw<
    Array<{ name: string; keys: unknown; changedAt: Date }>
  >`
    SELECT name, definition->'search'->'metadata' AS keys,
           search_changed_at AS "changedAt"
    FROM "chat"."provisioned_space_kinds"
    WHERE search_changed_at IS NOT NULL
      AND search_built_at IS DISTINCT FROM search_changed_at
      AND search_changed_at < now() - make_interval(secs => ${settleMs / 1000})
    ORDER BY name`;

  const kinds: string[] = [];
  let rows = 0;
  for (const { name, keys, changedAt } of due) {
    const list = Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === "string")
      : [];
    const count = await rebuildKind(name, list, batchSize);
    await prisma.$executeRaw`
      UPDATE "chat"."provisioned_space_kinds"
      SET search_built_at = ${changedAt}
      WHERE name = ${name} AND search_changed_at = ${changedAt}`;
    logger.info({ kind: name, rows: count }, "Rebuilt search text");
    kinds.push(name);
    rows += count;
  }
  return { kinds, rows };
};
