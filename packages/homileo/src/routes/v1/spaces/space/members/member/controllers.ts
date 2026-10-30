import type { SpaceFacts, SpaceRole } from "../../../../../../policy/index.js";
import { callerOf, type Caller } from "../../../../../../middleware/auth.js";
import { withChanges } from "../../../../../../utils/transaction.js";
import { MemberParamsSchema, PutMemberSchema } from "./schemas.js";
import type { Prisma } from "../../../../../../utils/db/prisma.js";
import { readableSpace } from "../../../../../../utils/access.js";
import { memberView } from "../../../../../../views/space.js";
import { db } from "../../../../../../utils/db/index.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../../utils/validateReq.js";
import {
  canChangeMember,
  canReadSession,
  canReadSpace,
} from "../../../../../../policy/index.js";
import {
  ArchivedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../../../utils/errors.js";

type Tx = Prisma.TransactionClient;

const lastOwner = () =>
  new ConflictError("A space needs at least one owner", "last_owner");

/** Refuses a change that would take `principalId`'s ownership and leave the space with none. */
const assertOwnerRemains = async (
  tx: Tx,
  spaceId: string,
  principalId: string
) => {
  const owners = await db.members.lockOwners(tx, spaceId);
  if (owners.length === 1 && owners[0] === principalId) throw lastOwner();
};

/**
 * The caller is judged with their own permissions. Someone else is judged from membership and
 * visibility alone: their kind grants and admin role are not known here, so they count for nothing.
 */
const judgedAs = (caller: Caller, principalId: string): Caller =>
  principalId === caller.principalId
    ? caller
    : {
        principalId,
        tereoUserId: "",
        isBot: false,
        permissions: [],
        isAdmin: false,
        organizationId: caller.organizationId,
      };

export const putMember = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId, principalId } = validateParams(MemberParamsSchema, req);
  const { role } = validateBody(PutMemberSchema, req);

  const result = await withChanges(async (tx, record) => {
    const { space, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    if (facts.archived) throw new ArchivedError("The space is archived");
    const target = await tx.principal.findUnique({
      where: { id: principalId },
    });
    if (!target) throw new NotFoundError("Principal not found");
    const current = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: principalId } },
    });
    // Already so: nothing to change, whoever asks, as long as they can read the space.
    if (current && current.role === role) {
      return { status: 200, member: current };
    }
    const from: SpaceRole | null = current?.role ?? null;
    if (
      !canChangeMember(caller, facts, {
        from,
        to: role,
        self: principalId === caller.principalId,
      })
    ) {
      throw new ForbiddenError(
        "You cannot make this change to the space's members"
      );
    }

    const base = {
      organizationId: space.organizationId,
      spaceId,
      actorId: caller.principalId,
      entity: { type: "space", id: spaceId },
    };
    if (current === null) {
      const row = await tx.spaceMember.create({
        data: { spaceId, userId: principalId, role },
      });
      await record({
        ...base,
        type: "space.member_added",
        payload: { spaceId, member: memberView(row) },
        audit: { action: "CREATE", userId: caller.tereoUserId },
      });
      return { status: 201, member: row };
    }
    if (current.role === "owner") {
      await assertOwnerRemains(tx, spaceId, principalId);
    }
    const row = await tx.spaceMember.update({
      where: { spaceId_userId: { spaceId, userId: principalId } },
      data: { role },
    });
    await record({
      ...base,
      type: "space.member_role_changed",
      payload: { spaceId, member: memberView(row), previousRole: current.role },
      audit: { action: "UPDATE", userId: caller.tereoUserId },
    });
    return { status: 200, member: row };
  });

  res.status(result.status).json({ member: memberView(result.member) });
};

/** Whether `judged`, who is no longer a member, still reads the space. */
const stillReadsSpace = (judged: Caller, facts: SpaceFacts) =>
  canReadSpace(judged, { ...facts, role: null });

export const removeMember = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId, principalId } = validateParams(MemberParamsSchema, req);

  await withChanges(async (tx, record) => {
    const { space, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    // Leaving is the one change an archived space still takes.
    if (facts.archived && principalId !== caller.principalId) {
      throw new ArchivedError("The space is archived");
    }
    const current = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: principalId } },
    });
    if (!current) throw new NotFoundError("Member not found");
    if (
      !canChangeMember(caller, facts, {
        from: current.role,
        to: null,
        self: principalId === caller.principalId,
      })
    ) {
      throw new ForbiddenError("You cannot remove this member");
    }
    if (current.role === "owner") {
      await assertOwnerRemains(tx, spaceId, principalId);
    }

    // Sessions are locked after the space and before their participants change.
    const sessionIds = await db.members.lockActiveSessions(
      tx,
      spaceId,
      principalId
    );
    await tx.spaceMember.delete({
      where: { spaceId_userId: { spaceId, userId: principalId } },
    });
    await tx.sessionParticipant.updateMany({
      where: {
        sessionId: { in: sessionIds },
        userId: principalId,
        leftAt: null,
      },
      data: { leftAt: new Date() },
    });

    const base = {
      organizationId: space.organizationId,
      spaceId,
      actorId: caller.principalId,
    };
    await record({
      ...base,
      type: "space.member_removed",
      entity: { type: "space", id: spaceId },
      payload: { spaceId, principalId },
      audit: { action: "DELETE", userId: caller.tereoUserId },
    });
    for (const sessionId of sessionIds) {
      await record({
        ...base,
        type: "session.participant_removed",
        sessionId,
        entity: { type: "session", id: sessionId },
        payload: { sessionId, principalId },
      });
    }

    const judged = judgedAs(caller, principalId);
    const readsSpace = stillReadsSpace(judged, facts);
    if (!readsSpace) {
      await record({
        ...base,
        type: "space.access_revoked",
        entity: { type: "space", id: spaceId },
        payload: { principalId, spaceId },
      });
    }
    const sessions = await tx.session.findMany({
      where: { id: { in: sessionIds } },
      orderBy: { id: "asc" },
    });
    for (const session of sessions) {
      const readable = canReadSession(judged, {
        organizationId: session.organizationId,
        type: session.type,
        space: { ...facts, role: null },
        access: session.access,
        archived: session.archivedAt !== null,
        participantRole: null,
      });
      if (readable) continue;
      await record({
        ...base,
        type: "session.access_revoked",
        sessionId: session.id,
        entity: { type: "session", id: session.id },
        payload: { principalId, sessionId: session.id },
      });
    }
  });

  res.status(204).end();
};
