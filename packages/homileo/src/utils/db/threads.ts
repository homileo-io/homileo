import { prisma, type Prisma } from "./prisma.js";
import type { Message } from "./messages.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

export interface Follower {
  following: boolean;
  lastReadSeq: bigint;
}

/** Up to `limit` replies above `after`, ascending by `seq`, and whether more follow. */
export const listReplies = async (
  client: Client,
  rootId: string,
  after: number,
  limit: number
): Promise<{ rows: Message[]; hasAfter: boolean }> => {
  const rows = await client.message.findMany({
    where: { threadRootId: rootId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasAfter: rows.length > limit };
};

/** The `seq` of the thread's newest reply, or null when it has none. */
export const newestReplySeq = async (
  client: Client,
  rootId: string
): Promise<bigint | null> => {
  const newest = await client.message.aggregate({
    where: { threadRootId: rootId },
    _max: { seq: true },
  });
  return newest._max.seq;
};

export const findFollower = (
  client: Client,
  rootId: string,
  userId: string
): Promise<Follower | null> =>
  client.threadFollower.findUnique({
    where: { threadRootId_userId: { threadRootId: rootId, userId } },
    select: { following: true, lastReadSeq: true },
  });

/**
 * Moves the caller's thread read position forward to `seq`, never back. A caller
 * with no row gets one that does not follow. Returns the position before and after.
 */
export const advanceRead = async (
  tx: Tx,
  rootId: string,
  userId: string,
  seq: bigint
): Promise<{ before: bigint; after: bigint }> => {
  const rows = await tx.$queryRaw<Array<{ last_read_seq: bigint }>>`
    SELECT last_read_seq FROM "chat"."thread_followers"
    WHERE thread_root_id = ${rootId}::uuid AND user_id = ${userId}::uuid
    FOR UPDATE`;
  if (rows.length === 0) {
    await tx.threadFollower.create({
      data: {
        threadRootId: rootId,
        userId,
        following: false,
        lastReadSeq: seq,
      },
    });
    return { before: 0n, after: seq };
  }
  const before = rows[0].last_read_seq;
  if (seq <= before) return { before, after: before };
  await tx.threadFollower.update({
    where: { threadRootId_userId: { threadRootId: rootId, userId } },
    data: { lastReadSeq: seq },
  });
  return { before, after: seq };
};

/**
 * Sets whether the caller follows the thread; a new row starts unread. One statement, so a row
 * another request creates meanwhile (a thread read) is updated rather than a unique violation.
 */
export const setFollowing = async (
  tx: Tx,
  rootId: string,
  userId: string,
  following: boolean
): Promise<Follower> => {
  const rows = await tx.$queryRaw<
    Array<{ following: boolean; last_read_seq: bigint }>
  >`
    INSERT INTO "chat"."thread_followers"
      (thread_root_id, user_id, following, last_read_seq)
    VALUES (${rootId}::uuid, ${userId}::uuid, ${following}, 0)
    ON CONFLICT (thread_root_id, user_id)
    DO UPDATE SET following = EXCLUDED.following
    RETURNING following, last_read_seq`;
  return { following: rows[0].following, lastReadSeq: rows[0].last_read_seq };
};
