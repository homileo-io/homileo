import { joinRequestView, memberView } from "../views/space.js";
import { canModerateSpace } from "../policy/index.js";
import type { Caller } from "../middleware/auth.js";
import { withChanges } from "./transaction.js";
import { readableSpace } from "./access.js";
import {
  ArchivedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";

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

    const base = {
      organizationId: space.organizationId,
      spaceId,
      actorId: caller.principalId,
      entity: { type: "space", id: spaceId },
    };
    if (decision === "approved") {
      const existing = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: principalId } },
      });
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
