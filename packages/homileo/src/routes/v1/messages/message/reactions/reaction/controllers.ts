import { validateParams } from "../../../../../../utils/validateReq.js";
import type { MessageContext } from "../../../../../../utils/access.js";
import { withChanges } from "../../../../../../utils/transaction.js";
import type { Prisma } from "../../../../../../utils/db/prisma.js";
import { lockedMessage, refuseIfArchived } from "../../utils.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { canReact } from "../../../../../../policy/index.js";
import { db } from "../../../../../../utils/db/index.js";
import { ReactionParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  ArchivedError,
  ForbiddenError,
  NotAParticipantError,
  NotFoundError,
} from "../../../../../../utils/errors.js";

/** The message under the session lock, once reacting to it is allowed. */
const reactableMessage = async (
  tx: Prisma.TransactionClient,
  caller: ReturnType<typeof callerOf>,
  messageId: string
): Promise<MessageContext> => {
  const context = await lockedMessage(tx, caller, messageId);
  if (context.message.deletedAt !== null) {
    throw new ArchivedError("The message was deleted");
  }
  refuseIfArchived(context.facts);
  if (!canReact(caller, context.facts)) {
    if (context.facts.participantRole === null)
      throw new NotAParticipantError();
    throw new ForbiddenError("You may not react to this message");
  }
  return context;
};

const summariesOf = async (tx: Prisma.TransactionClient, messageId: string) =>
  (await db.messages.reactionSummaries(tx, [messageId])).get(messageId) ?? [];

export const addReaction = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId, emoji } = validateParams(ReactionParamsSchema, req);

  const { added, reactions } = await withChanges(async (tx, record) => {
    const { session } = await reactableMessage(tx, caller, messageId);
    const inserted = await db.reactions.insertReaction(
      tx,
      messageId,
      caller.principalId,
      emoji
    );
    if (inserted) {
      await record({
        organizationId: session.organizationId,
        spaceId: session.spaceId,
        sessionId: session.id,
        actorId: caller.principalId,
        type: "reaction.added",
        entity: { type: "message", id: messageId },
        payload: {
          sessionId: session.id,
          messageId,
          principalId: caller.principalId,
          emoji,
        },
      });
    }
    return { added: inserted, reactions: await summariesOf(tx, messageId) };
  });

  res.status(added ? 201 : 200).json({ reactions });
};

export const removeReaction = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId, emoji } = validateParams(ReactionParamsSchema, req);

  const reactions = await withChanges(async (tx, record) => {
    const { session } = await reactableMessage(tx, caller, messageId);
    const deleted = await db.reactions.deleteReaction(
      tx,
      messageId,
      caller.principalId,
      emoji
    );
    if (!deleted)
      throw new NotFoundError("You have not reacted with this emoji");
    await record({
      organizationId: session.organizationId,
      spaceId: session.spaceId,
      sessionId: session.id,
      actorId: caller.principalId,
      type: "reaction.removed",
      entity: { type: "message", id: messageId },
      payload: {
        sessionId: session.id,
        messageId,
        principalId: caller.principalId,
        emoji,
      },
    });
    return summariesOf(tx, messageId);
  });

  res.status(200).json({ reactions });
};
