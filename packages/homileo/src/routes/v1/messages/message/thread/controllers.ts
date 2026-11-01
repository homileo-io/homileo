import { BadRequestError } from "../../../../../utils/errors.js";
import { readableMessage } from "../../../../../utils/access.js";
import { db, prisma } from "../../../../../utils/db/index.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { MessageParamsSchema } from "../../schemas.js";
import type { Request, Response } from "express";
import { ThreadQuerySchema } from "./schemas.js";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";

export const getThread = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);
  const { after, limit } = validateQuery(ThreadQuerySchema, req);
  // One snapshot, so the root's replyCount matches the replies listed.
  const { hasAfter, follower, views } = await prisma.$transaction(
    async (tx) => {
      const { message: root } = await readableMessage(caller, messageId, {
        tx,
      });
      if (root.threadRootId !== null) {
        throw new BadRequestError(
          "reply_to_reply",
          "A reply has no thread of its own; ask for its root"
        );
      }
      const { rows, hasAfter } = await db.threads.listReplies(
        tx,
        root.id,
        after,
        limit
      );
      const follower = await db.threads.findFollower(
        tx,
        root.id,
        caller.principalId
      );
      const views = await db.messages.loadViews(tx, [root, ...rows]);
      return { hasAfter, follower, views };
    },
    { isolationLevel: "RepeatableRead" }
  );
  const [rootView, ...replies] = views;
  res.status(200).json({
    root: rootView,
    data: replies,
    hasAfter,
    follower: follower && {
      following: follower.following,
      lastReadSeq: Number(follower.lastReadSeq),
    },
  });
};
