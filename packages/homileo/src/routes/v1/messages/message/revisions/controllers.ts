import { validateParams } from "../../../../../utils/validateReq.js";
import { canReadRevisions } from "../../../../../policy/index.js";
import { readableMessage } from "../../../../../utils/access.js";
import { ForbiddenError } from "../../../../../utils/errors.js";
import { revisionView } from "../../../../../views/message.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { prisma } from "../../../../../utils/db/index.js";
import { MessageParamsSchema } from "../../schemas.js";
import type { Request, Response } from "express";
import { messageFactsOf } from "../utils.js";

export const listRevisions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId } = validateParams(MessageParamsSchema, req);
  const { message, facts } = await readableMessage(caller, messageId);

  if (!canReadRevisions(caller, facts, messageFactsOf(message))) {
    throw new ForbiddenError("You may not read this message's revisions");
  }

  const rows = await prisma.messageRevision.findMany({
    where: { messageId },
    orderBy: { revision: "asc" },
  });
  res.status(200).json({ data: rows.map(revisionView) });
};
