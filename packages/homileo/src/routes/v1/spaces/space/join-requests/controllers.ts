import { decodeCursor, encodeCursor } from "../../../../../utils/cursor.js";
import { canModerateSpace } from "../../../../../policy/index.js";
import { joinRequestView } from "../../../../../views/space.js";
import { readableSpace } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { SpaceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";
import {
  ForbiddenError,
  ValidationError,
} from "../../../../../utils/errors.js";
import {
  JoinRequestCursorSchema,
  ListJoinRequestsQuerySchema,
} from "./schemas.js";

export const listJoinRequests = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId } = validateParams(SpaceParamsSchema, req);
  const query = validateQuery(ListJoinRequestsQuerySchema, req);
  let after: { createdAt: Date; id: string } | undefined;
  if (query.cursor !== undefined) {
    const key = JoinRequestCursorSchema.safeParse(
      decodeCursor(query.cursor, 2)
    );
    if (!key.success) throw new ValidationError("Invalid cursor");
    after = { createdAt: new Date(key.data[0]), id: key.data[1] };
  }

  const { facts } = await readableSpace(caller, spaceId);
  if (!canModerateSpace(caller, facts)) {
    throw new ForbiddenError("Only a moderator can see join requests");
  }
  const found = await prisma.spaceJoinRequest.findMany({
    where: {
      spaceId,
      status: query.status,
      ...(after && {
        OR: [
          { createdAt: { gt: after.createdAt } },
          { createdAt: after.createdAt, id: { gt: after.id } },
        ],
      }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: query.limit + 1,
  });
  const rows = found.slice(0, query.limit);
  const last = rows.at(-1);
  res.status(200).json({
    data: rows.map(joinRequestView),
    nextCursor:
      found.length > query.limit && last
        ? encodeCursor([last.createdAt.toISOString(), last.id])
        : null,
  });
};
