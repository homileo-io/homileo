import { NotAParticipantError } from "../../../../../utils/errors.js";
import { readableSession } from "../../../../../utils/access.js";
import { participantView } from "../../../../../views/index.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { prisma } from "../../../../../utils/db/index.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { NotifyBodySchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const putNotify = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const { notify } = validateBody(NotifyBodySchema, req);

  const { participant } = await readableSession(caller, sessionId);
  if (!participant) throw new NotAParticipantError();

  const row = await prisma.sessionParticipant.update({
    where: {
      sessionId_userId: { sessionId, userId: caller.principalId },
    },
    data: { notify },
  });
  res.status(200).json({ participant: participantView(row) });
};
