import { NotAParticipantError } from "../../../../../utils/errors.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { readableSession } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { ReadBodySchema } from "./schemas.js";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const putRead = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const { seq } = validateBody(ReadBodySchema, req);

  const lastReadSeq = await withChanges(async (tx, record) => {
    const { session, participant } = await readableSession(caller, sessionId, {
      tx,
    });
    if (!participant) throw new NotAParticipantError();

    const moved = await db.participants.advanceRead(
      tx,
      sessionId,
      caller.principalId,
      seq
    );
    if (!moved) throw new NotAParticipantError();
    if (moved.after !== moved.before) {
      await record({
        type: "read.updated",
        organizationId: session.organizationId,
        spaceId: session.spaceId,
        sessionId,
        actorId: caller.principalId,
        entity: { type: "session", id: sessionId },
        payload: {
          principalId: caller.principalId,
          sessionId,
          threadRootId: null,
          lastReadSeq: Number(moved.after),
        },
      });
    }
    return Number(moved.after);
  });

  res.status(200).json({ lastReadSeq });
};
