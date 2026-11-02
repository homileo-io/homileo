import { postRefusalError } from "../../../../../../utils/postRefusals.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import type { MessageContext } from "../../../../../../utils/access.js";
import type { Prisma } from "../../../../../../utils/db/prisma.js";
import { reactRefusal } from "../../../../../../policy/index.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { db } from "../../../../../../utils/db/index.js";
import { ReactionParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import { lockedMessage } from "../../utils.js";
import {
  withChanges,
  type Recorder,
} from "../../../../../../utils/transaction.js";
import {
  ArchivedError,
  NotFoundError,
  ReactionLimitError,
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
  const refusal = reactRefusal(caller, context.facts);
  if (refusal) throw postRefusalError[refusal]();
  return context;
};

const summariesOf = async (tx: Prisma.TransactionClient, messageId: string) =>
  (await db.messages.reactionSummaries(tx, [messageId])).get(messageId) ?? [];

/**
 * Records a reaction change with the summary it leaves and its `reactionSeq`, both read under
 * the session lock, so the pair is exact whatever order the log replays it in.
 */
const recordReaction = async (
  tx: Prisma.TransactionClient,
  record: Recorder,
  o: {
    type: "reaction.added" | "reaction.removed";
    caller: ReturnType<typeof callerOf>;
    session: MessageContext["session"];
    messageId: string;
    emoji: string;
  }
) => {
  const reactionSeq = await db.reactions.bumpReactionSeq(tx, o.messageId);
  const reactions = await summariesOf(tx, o.messageId);
  await record({
    organizationId: o.session.organizationId,
    spaceId: o.session.spaceId,
    sessionId: o.session.id,
    actorId: o.caller.principalId,
    type: o.type,
    entity: { type: "message", id: o.messageId },
    payload: {
      sessionId: o.session.id,
      messageId: o.messageId,
      principalId: o.caller.principalId,
      emoji: o.emoji,
      reactions,
      reactionSeq,
    },
  });
  return { reactions, reactionSeq };
};

export const addReaction = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId, emoji } = validateParams(ReactionParamsSchema, req);

  const { added, ...body } = await withChanges(async (tx, record) => {
    const { session, message } = await reactableMessage(tx, caller, messageId);
    // Under the session lock, so concurrent adds cannot pass the limit together.
    if (await db.reactions.emojiLimitReached(tx, messageId, emoji)) {
      throw new ReactionLimitError(db.reactions.REACTION_EMOJI_MAX);
    }
    const inserted = await db.reactions.insertReaction(
      tx,
      messageId,
      caller.principalId,
      emoji
    );
    if (!inserted) {
      return {
        added: false,
        reactions: await summariesOf(tx, messageId),
        reactionSeq: Number(message.reactionSeq),
      };
    }
    const changed = await recordReaction(tx, record, {
      type: "reaction.added",
      caller,
      session,
      messageId,
      emoji,
    });
    return { added: true, ...changed };
  });

  res.status(added ? 201 : 200).json(body);
};

export const removeReaction = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId, emoji } = validateParams(ReactionParamsSchema, req);

  const body = await withChanges(async (tx, record) => {
    const { session } = await reactableMessage(tx, caller, messageId);
    const deleted = await db.reactions.deleteReaction(
      tx,
      messageId,
      caller.principalId,
      emoji
    );
    if (!deleted)
      throw new NotFoundError("You have not reacted with this emoji");
    return recordReaction(tx, record, {
      type: "reaction.removed",
      caller,
      session,
      messageId,
      emoji,
    });
  });

  res.status(200).json(body);
};
