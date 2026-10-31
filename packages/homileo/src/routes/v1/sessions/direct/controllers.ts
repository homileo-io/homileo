import { BadRequestError, NotFoundError } from "../../../../utils/errors.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { withChanges } from "../../../../utils/transaction.js";
import { sessionView } from "../../../../views/session.js";
import { callerOf } from "../../../../middleware/auth.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { DirectBodySchema } from "./schemas.js";

export const createDirect = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { principalId } = validateBody(DirectBodySchema, req);
  if (principalId === caller.principalId) {
    throw new BadRequestError(
      "cannot_dm_self",
      "A direct session needs two different principals"
    );
  }
  const directKey = [caller.principalId, principalId].sort().join(":");

  const { session, created } = await withChanges(async (tx, record) => {
    if (!(await db.sessions.principalExists(tx, principalId))) {
      throw new NotFoundError("Principal not found");
    }
    const inserted = await db.sessions.insertDirect(tx, {
      organizationId: caller.organizationId,
      directKey,
      createdBy: caller.principalId,
    });
    if (!inserted) {
      const existing = await db.sessions.findDirect(
        tx,
        caller.organizationId,
        directKey
      );
      if (!existing)
        throw new Error("The direct session vanished after a conflict");
      return { session: existing, created: false };
    }
    await record({
      type: "session.created",
      organizationId: inserted.organizationId,
      sessionId: inserted.id,
      actorId: caller.principalId,
      entity: { type: "session", id: inserted.id },
      payload: { session: sessionView(inserted) },
      audit: { action: "CREATE", userId: caller.tereoUserId },
    });
    await db.sessions.addParticipants(
      tx,
      record,
      inserted,
      [caller.principalId, principalId],
      "member",
      caller.principalId
    );
    return { session: inserted, created: true };
  });

  res.status(created ? 201 : 200).json({ session: sessionView(session) });
};
