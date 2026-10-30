import { ListMessagesQuerySchema, SendMessageBodySchema } from "./schemas.js";
import { callerOf, principalOf } from "../../../../../middleware/auth.js";
import { notifyMentioned } from "../../../../../utils/notifyMentions.js";
import { validatePayload } from "../../../../../utils/messageTypes.js";
import { withChanges } from "../../../../../utils/transaction.js";
import type { Prisma } from "../../../../../utils/db/prisma.js";
import { db, prisma } from "../../../../../utils/db/index.js";
import { postRefusal } from "../../../../../policy/index.js";
import { resolveMentions } from "../../../../../utils/resolveMentions.js";
import { warmKinds } from "../../../../../utils/kinds.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import type { Message } from "@homileo-io/sdk";
import {
  validateBody,
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import { readableSession } from "../../../../../utils/access.js";
import {
  AppError,
  ArchivedError,
  BadRequestError,
  NotAParticipantError,
  NotFoundError,
  PostingRestrictedError,
  ValidationError,
} from "../../../../../utils/errors.js";

const refusalError = {
  not_found: () => new NotFoundError("Session not found"),
  archived: () => new ArchivedError("The session is archived"),
  not_a_participant: () => new NotAParticipantError(),
  posting_restricted: () => new PostingRestrictedError(),
};

const invalidRoot = (message: string) =>
  new ValidationError(`Invalid request body. threadRootId: ${message}`, [
    { path: "threadRootId", message },
  ]);

export const listMessages = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const query = validateQuery(ListMessagesQuerySchema, req);
  await readableSession(caller, sessionId);

  const page = await db.messages.listPage(sessionId, query);
  res.status(200).json({
    data: await db.messages.loadViews(prisma, page.rows),
    hasBefore: page.hasBefore,
    hasAfter: page.hasAfter,
  });
};

export const sendMessage = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const sender = principalOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const body = validateBody(SendMessageBodySchema, req);
  await warmKinds();

  const outcome = await withChanges(
    async (tx, record): Promise<{ created: boolean; message: Message }> => {
      const context = await readableSession(caller, sessionId, {
        tx,
        lock: true,
      });
      const { session } = context;

      // Under the session lock, so a concurrent repeat finds the first one.
      const existing = await db.messages.findByClientId(
        tx,
        sessionId,
        caller.principalId,
        body.clientMessageId
      );
      if (existing) {
        const [message] = await db.messages.loadViews(tx, [existing]);
        return { created: false, message };
      }

      const refusal = postRefusal(caller, context.facts);
      if (refusal) throw refusalError[refusal]();

      await validatePayload(body.type, body.payload, tx);

      const root = body.threadRootId
        ? await db.messages.findInSession(tx, sessionId, body.threadRootId)
        : null;
      if (body.threadRootId) {
        if (!root) throw invalidRoot("No such message in this session");
        if (root.threadRootId !== null) {
          throw new BadRequestError(
            "reply_to_reply",
            "Reply to the thread's root, not to a reply"
          );
        }
        if (root.deletedAt !== null) {
          throw invalidRoot("The message was deleted");
        }
      }

      const now = new Date();
      const seq = await db.messages.nextSeq(tx, sessionId, now, !root);

      const mentions = await resolveMentions(tx, context, body.body);

      const row = await db.messages.insert(tx, {
        sessionId,
        seq,
        senderId: caller.principalId,
        clientMessageId: body.clientMessageId,
        type: body.type,
        body: body.body ?? null,
        bodyText: mentions.bodyText,
        payload: body.payload as Prisma.InputJsonValue | undefined,
        metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
        threadRootId: root?.id ?? null,
        createdAt: now,
      });

      await db.messages.insertMentions(
        tx,
        row,
        mentions.readers.map((p) => p.id),
        mentions
      );
      await notifyMentioned(tx, {
        organizationId: session.organizationId,
        senderId: caller.principalId,
        senderName: sender.displayName,
        bodyText: mentions.bodyText,
        readers: mentions.readers,
      });

      const change = {
        organizationId: session.organizationId,
        spaceId: session.spaceId,
        sessionId,
        actorId: caller.principalId,
      };
      const [message] = await db.messages.loadViews(tx, [row]);
      // Before `thread.updated`, so no one sees a reply counted before the reply itself.
      await record({
        ...change,
        type: "message.created",
        entity: { type: "message", id: row.id },
        payload: { message },
      });

      if (root) {
        const thread = await db.messages.countReply(tx, root.id, now);
        await db.messages.followOnReply(
          tx,
          root.id,
          root.senderId,
          caller.principalId,
          seq
        );
        await record({
          ...change,
          type: "thread.updated",
          entity: { type: "message", id: root.id },
          payload: {
            sessionId,
            rootId: root.id,
            replyCount: thread.replyCount,
            lastReplyAt: thread.lastReplyAt.toISOString(),
          },
        });
      } else {
        await db.messages.markRead(tx, sessionId, caller.principalId, seq);
      }

      return { created: true, message };
    }
  );

  if (!outcome.created) {
    throw new AppError(
      409,
      "duplicate_client_message",
      "A message with this clientMessageId was already sent to this session",
      { details: { message: outcome.message } }
    );
  }
  res.status(201).json({ message: outcome.message });
};
