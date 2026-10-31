import { validateParams } from "../../../../../utils/validateReq.js";
import { withChanges } from "../../../../../utils/transaction.js";
import { canManageSpace } from "../../../../../policy/index.js";
import { readableSpace } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { spaceView } from "../../../../../views/space.js";
import { SpaceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  AlreadyArchivedError,
  ForbiddenError,
} from "../../../../../utils/errors.js";

/** Archiving leaves the space's sessions as they are: the policy makes them read-only. */
export const archiveSpace = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId } = validateParams(SpaceParamsSchema, req);

  const space = await withChanges(async (tx, record) => {
    const { space: current, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    if (!canManageSpace(caller, facts)) {
      throw new ForbiddenError("Only an owner can archive a space");
    }
    if (facts.archived) throw new AlreadyArchivedError("The space is archived");

    const row = await tx.space.update({
      where: { id: current.id },
      data: { archivedAt: new Date() },
    });
    await record({
      type: "space.archived",
      organizationId: row.organizationId,
      spaceId: row.id,
      actorId: caller.principalId,
      entity: { type: "space", id: row.id },
      payload: { space: spaceView(row) },
      audit: { action: "UPDATE", userId: caller.tereoUserId },
    });
    return row;
  });

  res.status(200).json({ space: spaceView(space) });
};
