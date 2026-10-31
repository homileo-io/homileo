import { invalidateMessageTypes } from "./messageTypes.js";
import { hasPermission } from "./permissions.js";
import { type Prisma } from "./db/prisma.js";
import { db } from "./db/index.js";
import {
  BUILTIN_KIND,
  type ResolvedSpaceKind,
} from "../definitions/builtins.js";

type Tx = Prisma.TransactionClient;

/** Other replicas re-provision on their own start; they pick the change up within this. */
const CACHE_TTL_MS = 60_000;

interface Cache {
  kinds: Map<string, ResolvedSpaceKind>;
  loadedAt: number;
}

let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
// Bumped by `invalidateKinds`, so a load that began before it is not stored.
let generation = 0;

// Transactions open in this process. While any is, a stale cache is served as it is:
// a reload would wait on a second connection while the transaction holds row locks.
let openTransactions = 0;

/** `withChanges` calls it around `fn` (+1 on entry, -1 on exit). */
export const setInTransaction = (delta: 1 | -1): void => {
  openTransactions += delta;
};

const load = (): Promise<Cache> => {
  const started = generation;
  const loadingNow = (async () => {
    const kinds = new Map<string, ResolvedSpaceKind>([
      [BUILTIN_KIND.name, BUILTIN_KIND],
    ]);
    for (const row of await db.provisioned.listKinds()) {
      kinds.set(row.name, row.definition);
    }
    const loaded = { kinds, loadedAt: Date.now() };
    if (started === generation) cache = loaded;
    return loaded;
  })().finally(() => {
    if (loading === loadingNow) loading = null;
  });
  loading = loadingNow;
  return loadingNow;
};

const kinds = async (
  { duringTransaction }: { duringTransaction: boolean } = {
    duringTransaction: true,
  }
): Promise<Map<string, ResolvedSpaceKind>> => {
  if (cache) {
    const fresh = Date.now() - cache.loadedAt < CACHE_TTL_MS;
    if (fresh || (duringTransaction && openTransactions > 0))
      return cache.kinds;
  }
  return (await (loading ?? load())).kinds;
};

/** Loads the cache if it is cold or stale, so a transaction holding a lock never waits on a second connection for it (`withChanges` calls it). It reloads even while other transactions are open. */
export const warmKinds = async (): Promise<void> => {
  await kinds({ duringTransaction: false });
};

/** A kind by name, retired ones included (a space keeps its kind), or `null`. */
export const getKind = async (
  name: string
): Promise<ResolvedSpaceKind | null> => (await kinds()).get(name) ?? null;

/**
 * An active kind, read in `tx` with `FOR SHARE`: retiring it (which takes the
 * row `FOR UPDATE` first) waits for this transaction, or this waits for it.
 */
export const activeKind = async (
  tx: Tx,
  name: string
): Promise<ResolvedSpaceKind | null> => {
  if (name === BUILTIN_KIND.name) return BUILTIN_KIND;
  const rows = await tx.$queryRaw<Array<{ definition: ResolvedSpaceKind }>>`
    SELECT definition FROM "chat"."provisioned_space_kinds"
    WHERE name = ${name} AND retired_at IS NULL
    FOR SHARE`;
  return rows[0]?.definition ?? null;
};

/** The names of the kinds one of whose grants the permissions satisfy. */
export const kindsGrantingRead = async (
  permissions: string[]
): Promise<string[]> =>
  [...(await kinds()).values()]
    .filter((kind) =>
      kind.grants.some((g) => hasPermission(permissions, g.permission))
    )
    .map((kind) => kind.name);

/** Drops the cache, and the message types' too: provisioning changed them. */
export const invalidateKinds = (): void => {
  generation++;
  cache = null;
  loading = null;
  invalidateMessageTypes();
};
