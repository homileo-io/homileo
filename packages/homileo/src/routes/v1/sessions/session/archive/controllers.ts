import { validateParams } from "../../../../../utils/validateReq.js";
import { canArchiveSession } from "../../../../../policy/index.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { readableSession } from "../../../../../utils/access.js";
import { sessionView } from "../../../../../views/session.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { db } from "../../../../../utils/db/index.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  AlreadyArchivedError,
  ForbiddenError,
} from "../../../../../utils/errors.js";

export const archiveSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);

  const session = await withChanges(async (tx, record) => {
    await db.sessions.lockSpaceOf(tx, sessionId);
    const { facts } = await readableSession(caller, sessionId, {
      tx,
      lock: true,
      adminManage: true,
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
    return row;
  });

  res.status(200).json({ session: sessionView(session) });
};
