import { validateParams } from "../../../../../utils/validateReq.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { readableSession } from "../../../../../utils/access.js";
import { sessionView } from "../../../../../views/session.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  canArchiveSession,
  canReadSession,
} from "../../../../../policy/index.js";
import {
  AlreadyArchivedError,
  ForbiddenError,
} from "../../../../../utils/errors.js";

export const archiveSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);

  const { session, readable } = await withChanges(async (tx, record) => {
    await db.sessions.lockSpaceOf(tx, caller.organizationId, sessionId);
    const { facts } = await readableSession(caller, sessionId, {
      tx,
      lock: true,
      manage: true,
    });
    if (!canArchiveSession(caller, facts)) {
      throw new ForbiddenError("You may not archive this session");
    }
    if (facts.archived)
      throw new AlreadyArchivedError("The session is already archived");

    const row = await tx.session.update({
      where: { id: sessionId },
      data: { archivedAt: new Date() },
    });
    await record({
      type: "session.archived",
      organizationId: row.organizationId,
      spaceId: row.spaceId,
      sessionId: row.id,
      actorId: caller.principalId,
      entity: { type: "session", id: row.id },
      payload: { session: sessionView(row) },
      audit: { action: "UPDATE", userId: caller.tereoUserId },
    });
    return { session: row, readable: canReadSession(caller, facts) };
  });

  // An admin or moderator archiving a session it cannot read gets no view of it.
  if (!readable) {
    res.status(204).end();
    return;
  }
  res.status(200).json({ session: sessionView(session) });
};
