import { NotAParticipantError } from "../../../../../utils/errors.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { readableSession } from "../../../../../utils/access.js";
import { participantView } from "../../../../../views/index.js";
import { callerOf } from "../../../../../middleware/auth.js";
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

  const row = await withChanges(async (tx) => {
    const { participant } = await readableSession(caller, sessionId, { tx });
    if (!participant) throw new NotAParticipantError();
    // Only a current row: a leave that commits first leaves nothing to update.
    const { count } = await tx.sessionParticipant.updateMany({
      where: { sessionId, userId: caller.principalId, leftAt: null },
      data: { notify },
    });
    if (count === 0) throw new NotAParticipantError();
    return tx.sessionParticipant.findUniqueOrThrow({
      where: { sessionId_userId: { sessionId, userId: caller.principalId } },
    });
  });
  res.status(200).json({ participant: participantView(row) });
};
