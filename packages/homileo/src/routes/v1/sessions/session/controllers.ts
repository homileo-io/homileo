import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { SessionParamsSchema, UpdateSessionBodySchema } from "./schemas.js";
import { participantView, sessionView } from "../../../../views/session.js";
import { ArchivedError, ForbiddenError } from "../../../../utils/errors.js";
import { canEditSessionSettings } from "../../../../policy/index.js";
import { BUILTIN_KIND } from "../../../../definitions/builtins.js";
import { assertState } from "../../../../utils/spaceSettings.js";
import { withChanges } from "../../../../utils/transaction.js";
import { readableSession } from "../../../../utils/access.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { callerOf } from "../../../../middleware/auth.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import { isDeepStrictEqual } from "util";

export const getSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const { session, participant } = await readableSession(caller, sessionId);
  res.status(200).json({
    session: sessionView(session),
    participant: participant ? participantView(participant) : null,
  });
};

export const updateSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const body = validateBody(UpdateSessionBodySchema, req);

  const session = await withChanges(async (tx, record) => {
    await db.sessions.lockSpaceOf(tx, sessionId);
    const { session: current, facts } = await readableSession(
      caller,
      sessionId,
      { tx, lock: true }
    );
    if (facts.archived || facts.space?.archived) {
      throw new ArchivedError("The session is archived");
    }
    if (!canEditSessionSettings(caller, facts)) {
      throw new ForbiddenError("You may not change this session's settings");
    }

    assertState(facts.space?.kind ?? BUILTIN_KIND, body.state);

    const data: Prisma.SessionUpdateInput = {};
    if (body.name !== undefined && body.name !== current.name) {
      data.name = body.name;
    }
    if (body.state !== undefined && body.state !== current.state) {
      data.state = body.state;
    }
    if (
      body.externalRef !== undefined &&
      body.externalRef !== current.externalRef
    ) {
      data.externalRef = body.externalRef;
    }
    if (
      body.metadata !== undefined &&
      !isDeepStrictEqual(body.metadata, current.metadata)
    ) {
      data.metadata = body.metadata as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) return current;

    const row = await tx.session.update({ where: { id: sessionId }, data });
    await record({
      type: "session.updated",
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
