import type { Prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

/** Distinct emoji one message may carry. */
export const REACTION_EMOJI_MAX = 50;

/** Whether the message has no room for this emoji: it lacks it and already carries the maximum. */
export const emojiLimitReached = async (
  tx: Tx,
  messageId: string,
  emoji: string
): Promise<boolean> => {
  const [row] = await tx.$queryRaw<Array<{ distinct: number; has: boolean }>>`
    SELECT count(DISTINCT emoji)::int AS distinct, coalesce(bool_or(emoji = ${emoji}), false) AS has
    FROM "chat"."reactions"
    WHERE message_id = ${messageId}::uuid`;
  return !row.has && row.distinct >= REACTION_EMOJI_MAX;
};

/** Adds the caller's reaction; `false` when it was already there. */
export const insertReaction = async (
  tx: Tx,
  messageId: string,
  userId: string,
  emoji: string
): Promise<boolean> => {
  const rows = await tx.$executeRaw`
    INSERT INTO "chat"."reactions" (message_id, user_id, emoji)
    VALUES (${messageId}::uuid, ${userId}::uuid, ${emoji})
    ON CONFLICT DO NOTHING`;
  return rows === 1;
};

/** Raises the message's `reaction_seq`; call under the session lock, once per change. */
export const bumpReactionSeq = async (
  tx: Tx,
  messageId: string
): Promise<number> => {
  const [row] = await tx.$queryRaw<Array<{ reaction_seq: bigint }>>`
    UPDATE "chat"."messages" SET reaction_seq = reaction_seq + 1
    WHERE id = ${messageId}::uuid
    RETURNING reaction_seq`;
  return Number(row.reaction_seq);
};

/** Removes the caller's reaction; `false` when there was none. */
export const deleteReaction = async (
  tx: Tx,
  messageId: string,
  userId: string,
  emoji: string
): Promise<boolean> => {
  const rows = await tx.$executeRaw`
    DELETE FROM "chat"."reactions"
    WHERE message_id = ${messageId}::uuid AND user_id = ${userId}::uuid AND emoji = ${emoji}`;
  return rows === 1;
};
