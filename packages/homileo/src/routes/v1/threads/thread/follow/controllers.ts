import { withChanges } from "../../../../../utils/transaction.js";
import { BadRequestError } from "../../../../../utils/errors.js";
import { readableMessage } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { ThreadParamsSchema } from "../../schemas.js";
import type { Request, Response } from "express";
import { FollowBodySchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const putFollow = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { rootId } = validateParams(ThreadParamsSchema, req);
  const { following } = validateBody(FollowBodySchema, req);
  const row = await withChanges(async (tx) => {
    // The session row first, then the follower row, as a thread read takes them.
    const { message: root } = await readableMessage(caller, rootId, {
      tx,
      lock: true,
    });
    if (root.threadRootId !== null) {
      throw new BadRequestError(
        "reply_to_reply",
        "A reply has no thread of its own; use its root"
      );
    }
    return db.threads.setFollowing(tx, root.id, caller.principalId, following);
  });
  res.status(200).json({ following: row.following });
};
