import { canReadSpace, joinSpaceOutcome } from "../../../../../policy/index.js";
import { ForbiddenError, NotFoundError } from "../../../../../utils/errors.js";
import { joinRequestView, memberView } from "../../../../../views/space.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { readableSpace } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { SpaceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const joinSpace = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId } = validateParams(SpaceParamsSchema, req);

  const outcome = await withChanges(async (tx, record) => {
    const { space, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    const decision = joinSpaceOutcome(caller, facts);
    if (decision === "forbidden") {
      if (!canReadSpace(caller, facts))
        throw new NotFoundError("Space not found");
      throw new ForbiddenError("This space cannot be joined");
    }
    const base = {
      organizationId: space.organizationId,
      spaceId,
      actorId: caller.principalId,
      entity: { type: "space", id: spaceId },
    };

    if (decision === "join") {
      const existing = await tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: caller.principalId } },
      });
      if (existing)
        return { status: 200, body: { member: memberView(existing) } };
      const row = await tx.spaceMember.create({
        data: { spaceId, userId: caller.principalId, role: "member" },
      });
      await record({
        ...base,
        type: "space.member_added",
        payload: { spaceId, member: memberView(row) },
        audit: { action: "CREATE", userId: caller.tereoUserId },
      });
      return { status: 200, body: { member: memberView(row) } };
    }

    const pending = await tx.spaceJoinRequest.findFirst({
      where: { spaceId, userId: caller.principalId, status: "pending" },
    });
    if (pending) {
      return { status: 202, body: { request: joinRequestView(pending) } };
    }
    const row = await tx.spaceJoinRequest.create({
      data: { spaceId, userId: caller.principalId },
    });
    await record({
      ...base,
      type: "space.join_requested",
      payload: { request: joinRequestView(row) },
    });
    return { status: 202, body: { request: joinRequestView(row) } };
  });

  res.status(outcome.status).json(outcome.body);
};
