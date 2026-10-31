import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { lockedMessage, messageFactsOf, refuseIfArchived } from "./utils.js";
import { EditMessageBodySchema, MessageParamsSchema } from "../schemas.js";
import { callerOf, principalOf } from "../../../../middleware/auth.js";
import { resolveMentions } from "../../../../utils/resolveMentions.js";
import { notifyMentioned } from "../../../../utils/notifyMentions.js";
import { validatePayload } from "../../../../utils/messageTypes.js";
import { withChanges } from "../../../../utils/transaction.js";
import { readableMessage } from "../../../../utils/access.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { db, prisma } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { isDeepStrictEqual } from "node:util";
import {
  canDeleteMessage,
  canEditMessage,
  editWindowOpen,
} from "../../../../policy/index.js";
import {
  ArchivedError,
  EditWindowClosedError,
  ForbiddenError,
} from "../../../../utils/errors.js";

export const getMessage = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);
  const { message } = await readableMessage(caller, messageId);

  const [view] = await db.messages.loadViews(prisma, [message]);
  res.status(200).json({ message: view });
};

export const editMessage = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const editor = principalOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);
  const body = validateBody(EditMessageBodySchema, req);

  const message = await withChanges(async (tx, record) => {
    const context = await lockedMessage(tx, caller, messageId);
    const { message: row, session, facts } = context;
    if (row.deletedAt !== null) {
      throw new ArchivedError("The message was deleted");
    }
    refuseIfArchived(facts);
    const now = new Date();
    const messageFacts = messageFactsOf(row);
    if (!canEditMessage(caller, facts, messageFacts, now)) {
      // Only the window failed: the same call at the message's creation passes.
      if (
        !editWindowOpen(facts, messageFacts, now) &&
        canEditMessage(caller, facts, messageFacts, row.createdAt)
      ) {
        throw new EditWindowClosedError();
      }
      throw new ForbiddenError("You may not edit this message");
    }

    if (body.payload !== undefined) {
      await validatePayload(row.type, body.payload, tx);
    }

    const bodyChanged = body.body !== undefined && body.body !== row.body;
    const payloadChanged =
      body.payload !== undefined &&
      !isDeepStrictEqual(body.payload, row.payload);
    const metadataChanged =
      body.metadata !== undefined &&
      !isDeepStrictEqual(body.metadata, row.metadata);
    if (!bodyChanged && !payloadChanged && !metadataChanged) {
      const [view] = await db.messages.loadViews(tx, [row]);
      return view;
    }

    const data: Prisma.MessageUpdateInput = {};
    if (metadataChanged) data.metadata = body.metadata as Prisma.InputJsonValue;
    if (bodyChanged || payloadChanged) {
      const newBody = bodyChanged ? body.body! : row.body;
      const newPayload = payloadChanged ? body.payload : row.payload;
      data.revision = row.revision + 1;
      data.editedAt = now;
      data.body = newBody;
      data.payload = (newPayload ?? undefined) as Prisma.InputJsonValue;
      await tx.messageRevision.create({
        data: {
          messageId: row.id,
          revision: row.revision + 1,
          body: newBody,
          payload: (newPayload ?? undefined) as Prisma.InputJsonValue,
          editedBy: caller.principalId,
          editedAt: now,
        },
      });

      if (bodyChanged) {
        const mentions = await resolveMentions(tx, context, body.body);
        data.bodyText = mentions.bodyText;

        const before = new Set(await db.messages.mentionedUserIds(tx, row.id));
        await db.messages.deleteMentions(tx, row.id);
        await db.messages.insertMentions(
          tx,
          row,
          mentions.readers.map((p) => p.id),
          mentions
        );
        await notifyMentioned(tx, {
          organizationId: session.organizationId,
          senderId: caller.principalId,
          senderName: editor.displayName,
          bodyText: mentions.bodyText,
          readers: mentions.readers.filter((p) => !before.has(p.id)),
        });
      }
    }

    const updated = await tx.message.update({ where: { id: row.id }, data });
    const [view] = await db.messages.loadViews(tx, [updated]);
    await record({
      organizationId: session.organizationId,
      spaceId: session.spaceId,
      sessionId: session.id,
      actorId: caller.principalId,
      type: "message.edited",
      entity: { type: "message", id: row.id },
      payload: { message: view },
    });
    return view;
  });

  res.status(200).json({ message });
};

export const deleteMessage = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);

  const message = await withChanges(async (tx, record) => {
    const {
      message: row,
      session,
      facts,
    } = await lockedMessage(tx, caller, messageId);
    if (row.deletedAt !== null) {
      throw new ArchivedError("The message was already deleted");
    }
    refuseIfArchived(facts);
    if (!canDeleteMessage(caller, facts, messageFactsOf(row))) {
      throw new ForbiddenError("You may not delete this message");
    }

    const now = new Date();
    const deleted = await db.messages.markDeleted(
      tx,
      row.id,
      caller.principalId,
      now
    );
    await db.messages.deleteMentions(tx, row.id);

    const change = {
      organizationId: session.organizationId,
      spaceId: session.spaceId,
      sessionId: session.id,
      actorId: caller.principalId,
    };
    const [view] = await db.messages.loadViews(tx, [deleted]);
    await record({
      ...change,
      type: "message.deleted",
      entity: { type: "message", id: row.id },
      payload: { message: view },
      // A moderator removing someone else's message is the case worth an entry.
      ...(row.senderId !== caller.principalId && {
        audit: { action: "DELETE" as const, userId: caller.tereoUserId },
      }),
    });

    if (row.threadRootId) {
      const thread = await db.messages.uncountReply(tx, row.threadRootId);
      await record({
        ...change,
        type: "thread.updated",
        entity: { type: "message", id: row.threadRootId },
        payload: {
          sessionId: session.id,
          rootId: row.threadRootId,
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt?.toISOString() ?? null,
        },
      });
    }
    return view;
  });

  res.status(200).json({ message });
};
