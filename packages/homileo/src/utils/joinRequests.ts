import { joinRequestView, memberView } from "../views/space.js";
import type { ChangeEvent, ChangeInput } from "./changes.js";
import { canModerateSpace } from "../policy/index.js";
import type { Caller } from "../middleware/auth.js";
import { withChanges } from "./transaction.js";
import type { Prisma } from "./db/prisma.js";
import { readableSpace } from "./access.js";
import {
  ArchivedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";

type Tx = Prisma.TransactionClient;
type Record = (change: ChangeInput) => Promise<ChangeEvent>;

/**
 * Approves the principal's pending join request, if any, as `actorId`, for a principal who just
 * became a member some other way, and records `space.join_decided`.
 */
export const approvePendingJoinRequest = async (
  tx: Tx,
  record: Record,
  change: {
    organizationId: string;
    spaceId: string;
    actorId: string;
    /** The tereo user to audit the decision as; none for a change that is not audited. */
    auditUserId?: string;
  },
  principalId: string
): Promise<void> => {
  const pending = await tx.spaceJoinRequest.findFirst({
    where: { spaceId: change.spaceId, userId: principalId, status: "pending" },
  });
  if (!pending) return;
  const row = await tx.spaceJoinRequest.update({
    where: { id: pending.id },
    data: {
      status: "approved",
      decidedBy: change.actorId,
      decidedAt: new Date(),
    },
  });
  await record({
    type: "space.join_decided",
    organizationId: change.organizationId,
    spaceId: change.spaceId,
    actorId: change.actorId,
    entity: { type: "space", id: change.spaceId },
    payload: { request: joinRequestView(row) },
    ...(change.auditUserId && {
      audit: { action: "UPDATE", userId: change.auditUserId },
    }),
  });
};

/** Approving or denying the principal's latest join request; approving adds the member. */
export const decideJoinRequest = (
  caller: Caller,
  spaceId: string,
  principalId: string,
  decision: "approved" | "denied"
) =>
  withChanges(async (tx, record) => {
    const { space, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    if (!canModerateSpace(caller, facts)) {
      throw new ForbiddenError("Only a moderator can decide a join request");
    }
    const latest = await tx.spaceJoinRequest.findFirst({
      where: { spaceId, userId: principalId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (!latest) throw new NotFoundError("Join request not found");
    if (latest.status !== "pending") {
      throw new ConflictError(`The join request is already ${latest.status}`);
    }
    if (facts.archived) throw new ArchivedError("The space is archived");
    const existing = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: principalId } },
    });
    // Approving only closes a member's request; denying would contradict the membership.
    if (existing && decision === "denied") {
      throw new ConflictError(
        "The principal is already a member of the space",
        "already_member"
      );
    }

    const base = {
      organizationId: space.organizationId,
      spaceId,
      actorId: caller.principalId,
      entity: { type: "space", id: spaceId },
    };
    if (decision === "approved") {
      if (!existing) {
        const member = await tx.spaceMember.create({
          data: { spaceId, userId: principalId, role: "member" },
        });
        await record({
          ...base,
          type: "space.member_added",
          payload: { spaceId, member: memberView(member) },
          audit: { action: "CREATE", userId: caller.tereoUserId },
        });
      }
    }
    const row = await tx.spaceJoinRequest.update({
      where: { id: latest.id },
      data: {
        status: decision,
        decidedBy: caller.principalId,
        decidedAt: new Date(),
      },
    });
    await record({
      ...base,
      type: "space.join_decided",
      payload: { request: joinRequestView(row) },
      audit: { action: "UPDATE", userId: caller.tereoUserId },
    });
    return joinRequestView(row);
  });
