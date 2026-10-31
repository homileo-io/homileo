import { decodeCursor, encodeCursor } from "../../../../../utils/cursor.js";
import { ListMembersQuerySchema, MemberCursorSchema } from "./schemas.js";
import { principalView } from "../../../../../views/principal.js";
import { ValidationError } from "../../../../../utils/errors.js";
import { readableSpace } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { memberView } from "../../../../../views/space.js";
import { db } from "../../../../../utils/db/index.js";
import { SpaceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";

export const listMembers = async (req: Request, res: Response) => {
  const { spaceId } = validateParams(SpaceParamsSchema, req);
  const query = validateQuery(ListMembersQuerySchema, req);
  let after: { joinedAt: Date; principalId: string } | undefined;
  if (query.cursor !== undefined) {
    const key = MemberCursorSchema.safeParse(decodeCursor(query.cursor, 2));
    if (!key.success) throw new ValidationError("Invalid cursor");
    after = { joinedAt: new Date(key.data[0]), principalId: key.data[1] };
  }

  const { space } = await readableSpace(callerOf(req), spaceId);
  const page = await db.members.listPage(space.id, { ...query, after });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map((row) => ({
      ...memberView(row),
      principal: principalView(row.user),
    })),
    nextCursor:
      page.hasMore && last
        ? encodeCursor([last.joinedAt.toISOString(), last.userId])
        : null,
  });
};
