import type { MessageContext } from "../../../../utils/access.js";
import type { callerOf } from "../../../../middleware/auth.js";
import { readableMessage } from "../../../../utils/access.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { ArchivedError } from "../../../../utils/errors.js";
import { db } from "../../../../utils/db/index.js";

/** The message under the session lock, space first, so a concurrent change to either is seen. */
export const lockedMessage = async (
  tx: Prisma.TransactionClient,
  caller: ReturnType<typeof callerOf>,
  messageId: string
): Promise<MessageContext> => {
  const sessionId = await db.messages.sessionIdOf(tx, messageId);
  if (sessionId) await db.sessions.lockSpaceOf(tx, sessionId);
  return readableMessage(caller, messageId, { tx, lock: true });
};

/** A session or space that is archived takes no edits, as with sending. */
export const refuseIfArchived = (facts: MessageContext["facts"]): void => {
  if (facts.archived || (facts.space?.archived ?? false)) {
    throw new ArchivedError("The session is archived");
  }
};
