import { withChanges } from "../../../../../utils/transaction.js";
import { BadRequestError } from "../../../../../utils/errors.js";
import { readableMessage } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { ThreadParamsSchema } from "../../schemas.js";
import { ThreadReadBodySchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const putThreadRead = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { rootId } = validateParams(ThreadParamsSchema, req);
  const { seq } = validateBody(ThreadReadBodySchema, req);

  const lastReadSeq = await withChanges(async (tx, record) => {
    // The session row first, then the follower row.
    const { message: root, session } = await readableMessage(caller, rootId, {
      tx,
      lock: true,
    });
    if (root.threadRootId !== null) {
      throw new BadRequestError(
        "reply_to_reply",
        "A reply has no thread of its own; use its root"
      );
    }

    const newest = (await db.threads.newestReplySeq(tx, root.id)) ?? root.seq;
    const target = BigInt(seq) < newest ? BigInt(seq) : newest;
    const moved = await db.threads.advanceRead(
      tx,
      root.id,
      caller.principalId,
      target
    );
    if (moved.after !== moved.before) {
      await record({
        type: "read.updated",
        organizationId: session.organizationId,
        spaceId: session.spaceId,
        sessionId: session.id,
        actorId: caller.principalId,
        entity: { type: "message", id: root.id },
        payload: {
          principalId: caller.principalId,
          sessionId: session.id,
          threadRootId: root.id,
          lastReadSeq: Number(moved.after),
        },
      });
    }
    return Number(moved.after);
  });

  res.status(200).json({ lastReadSeq });
};
