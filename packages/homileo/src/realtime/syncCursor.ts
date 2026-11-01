import { ValidationError } from "../utils/errors.js";
import { decodeCursor } from "../utils/cursor.js";

/**
 * A place in the commit-ordered event log. `at` is the database's clock when
 * the position was issued; it tells a resync apart from a cursor too old to
 * trust.
 */
export interface SyncPosition {
  txId: bigint;
  id: bigint;
  at: Date;
}

// Postgres bigint and xid8 both fit in 64 unsigned bits.
const MAX_U64 = 2n ** 64n - 1n;
const MAX_CLOCK_SKEW_MS = 60_000;

/** Base64url JSON of `[txId, id, at]`: the ids as decimal strings, `at` in ms. */
export const encodeSyncCursor = (p: SyncPosition): string =>
  Buffer.from(
    JSON.stringify([p.txId.toString(), p.id.toString(), p.at.getTime()])
  ).toString("base64url");

const decimal = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) {
    throw new ValidationError("Invalid cursor");
  }
  const n = BigInt(v);
  if (n > MAX_U64) throw new ValidationError("Invalid cursor");
  return n;
};

export const decodeSyncCursor = (cursor: string): SyncPosition => {
  const [txId, id, at] = decodeCursor(cursor, 3);
  if (typeof at !== "number" || !Number.isSafeInteger(at)) {
    throw new ValidationError("Invalid cursor");
  }
  // A cursor from the future was not issued by this database.
  if (at > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new ValidationError("Invalid cursor");
  }
  return { txId: decimal(txId), id: decimal(id), at: new Date(at) };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** No transaction outlives this past the oldest retained day (Decision 3). */
export const RESYNC_MARGIN_MS = 10 * 60 * 1000;

/**
 * Whether a cursor issued at `at` may have missed events that retention dropped, given the
 * oldest retained day's lower bound. A cursor before that day always may. Within the margin
 * after it, a transaction still open across the boundary may have written into a dropped
 * day: that applies only once retention has dropped one, which leaves the oldest day at or
 * before the cutoff; a fresh deploy's oldest day is well after it.
 */
export const tooOldToSync = (
  at: Date,
  oldest: Date | null,
  now: Date,
  retentionDays: number
): boolean => {
  if (!oldest) return false;
  if (at.getTime() < oldest.getTime()) return true;
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const dropped = oldest.getTime() <= today - retentionDays * MS_PER_DAY;
  return dropped && at.getTime() < oldest.getTime() + RESYNC_MARGIN_MS;
};
