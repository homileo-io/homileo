import { participantView, memberView } from "../../../../../../views/index.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import type { SessionFacts } from "../../../../../../policy/index.js";
import { withChanges } from "../../../../../../utils/transaction.js";
import { readableSession } from "../../../../../../utils/access.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { db } from "../../../../../../utils/db/index.js";
import { ParticipantParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  canAddParticipant,
  canJoinSession,
  canLeaveSession,
  canReadSession,
  canRemoveParticipant,
} from "../../../../../../policy/index.js";
import {
  ArchivedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../../../utils/errors.js";

const refuseIfArchived = (facts: SessionFacts): void => {
  if (facts.space?.archived) throw new ArchivedError("The space is archived");
  if (facts.archived) throw new ArchivedError("The session is archived");
};

export const putParticipant = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId, principalId } = validateParams(
    ParticipantParamsSchema,
    req
  );

  const { row, created } = await withChanges(async (tx, record) => {
    await db.sessions.lockSpaceOf(tx, sessionId);
    const { session, facts } = await readableSession(caller, sessionId, {
      tx,
      lock: true,
    });
    const joining = principalId === caller.principalId;
    refuseIfArchived(facts);
    if (
      joining
        ? !canJoinSession(caller, facts)
        : !canAddParticipant(caller, facts)
    ) {
      throw new ForbiddenError(
        joining
          ? "You may not join this session"
          : "You may not add participants to this session"
      );
    }
    if (!(await db.sessions.principalExists(tx, principalId))) {
      throw new NotFoundError("Principal not found");
    }

    const current = await db.participants.findCurrent(
      tx,
      sessionId,
      principalId
    );
    if (current) return { row: current, created: false };

    if (session.spaceId && facts.space) {
      if (joining && facts.space.role === null) {
        const member = await tx.spaceMember.create({
          data: {
            spaceId: session.spaceId,
            userId: principalId,
            role: "member",
          },
        });
        await record({
          type: "space.member_added",
          organizationId: session.organizationId,
          spaceId: session.spaceId,
          actorId: caller.principalId,
          entity: { type: "space", id: session.spaceId },
          payload: { spaceId: session.spaceId, member: memberView(member) },
          audit: { action: "CREATE", userId: caller.tereoUserId },
        });
      } else if (!joining) {
        const missing = await db.sessions.nonMemberIndexes(
          tx,
          session.spaceId,
          [principalId]
        );
        if (missing.length > 0) {
          throw new ValidationError(
            "The principal is not a member of the space",
            [
              {
                path: "principalId",
                message: "Must be a member of the session's space",
              },
            ]
          );
        }
      }
    }

    const [added] = await db.sessions.addParticipants(
      tx,
      record,
      session,
      [principalId],
      "member",
      caller.principalId
    );
    return { row: added, created: true };
  });

  res.status(created ? 201 : 200).json({ participant: participantView(row) });
};

export const removeParticipant = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId, principalId } = validateParams(
    ParticipantParamsSchema,
    req
  );

  await withChanges(async (tx, record) => {
    await db.sessions.lockSpaceOf(tx, sessionId);
    const { session, facts } = await readableSession(caller, sessionId, {
      tx,
      lock: true,
    });
    const leaving = principalId === caller.principalId;
    // Leaving is the one change an archived session or space still takes.
    if (!leaving) refuseIfArchived(facts);
    const target = await db.participants.findCurrent(
      tx,
      sessionId,
      principalId
    );
    if (!target) throw new NotFoundError("Participant not found");
    if (
      leaving
        ? !canLeaveSession(caller, facts)
        : !canRemoveParticipant(caller, facts)
    ) {
      throw new ForbiddenError(
        leaving
          ? "You may not leave this session"
          : "You may not remove participants from this session"
      );
    }

    await tx.sessionParticipant.update({
      where: { sessionId_userId: { sessionId, userId: principalId } },
      data: { leftAt: new Date() },
    });
    // The last owner of a space-less group hands the session on; there is no event for a role change.
    if (target.role === "owner" && session.spaceId === null) {
      await db.participants.promoteIfNoOwner(tx, sessionId);
    }

    const base = {
      organizationId: session.organizationId,
      spaceId: session.spaceId,
      sessionId,
      actorId: caller.principalId,
      entity: { type: "session", id: sessionId },
    };
    await record({
      ...base,
      type: "session.participant_removed",
      payload: { sessionId, principalId },
      ...(!leaving && {
        audit: { action: "DELETE" as const, userId: caller.tereoUserId },
      }),
    });

    let revoked: boolean;
    if (leaving) {
      revoked = !canReadSession(caller, { ...facts, participantRole: null });
    } else if (facts.space === null || session.access === "members") {
      revoked = true;
    } else {
      const member = await tx.spaceMember.findUnique({
        where: {
          spaceId_userId: { spaceId: session.spaceId!, userId: principalId },
        },
      });
      revoked = member === null && facts.space.visibility !== "public";
    }
    if (revoked) {
      await record({
        ...base,
        type: "session.access_revoked",
        payload: { principalId, sessionId },
      });
    }
  });

  res.status(204).end();
};
