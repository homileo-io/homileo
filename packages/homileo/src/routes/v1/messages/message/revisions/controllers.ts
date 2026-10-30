import { validateParams } from "../../../../../utils/validateReq.js";
import { canModerateSpace } from "../../../../../policy/index.js";
import { readableMessage } from "../../../../../utils/access.js";
import { ForbiddenError } from "../../../../../utils/errors.js";
import { revisionView } from "../../../../../views/message.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { prisma } from "../../../../../utils/db/index.js";
import { MessageParamsSchema } from "../../schemas.js";
import type { Request, Response } from "express";

/** The sender and whoever moderates the message's space; a deleted message's text stays out of everyone else's reach. */
export const listRevisions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);
  const { message, facts } = await readableMessage(caller, messageId);

  const isSender = message.senderId === caller.principalId;
  if (!isSender && !(facts.space && canModerateSpace(caller, facts.space))) {
    throw new ForbiddenError("You may not read this message's revisions");
  }

  const rows = await prisma.messageRevision.findMany({
    where: { messageId },
    orderBy: { revision: "asc" },
  });
  res.status(200).json({ data: rows.map(revisionView) });
};
