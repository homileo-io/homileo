import { BadRequestError } from "../../../../../utils/errors.js";
import { readableMessage } from "../../../../../utils/access.js";
import { db, prisma } from "../../../../../utils/db/index.js";
import { callerOf } from "../../../../../middleware/auth.js";
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
  const { message: root } = await readableMessage(caller, rootId);
  if (root.threadRootId !== null) {
    throw new BadRequestError(
      "reply_to_reply",
      "A reply has no thread of its own; use its root"
    );
  }

  const row = await db.threads.setFollowing(
    prisma,
    root.id,
    caller.principalId,
    following
  );
  res.status(200).json({ following: row.following });
};
