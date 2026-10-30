import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

export const ListMembersQuerySchema = z.strictObject({
  role: z.enum(["owner", "moderator", "member"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: `joined_at` as an ISO string, then the principal id. */
export const MemberCursorSchema = z.tuple([z.iso.datetime(), IdSchema]);
