import type { Prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

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
