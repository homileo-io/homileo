import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

export const MemberParamsSchema = z.object({
  spaceId: IdSchema,
  principalId: IdSchema,
});

export const PutMemberSchema = z.strictObject({
  role: z.enum(["owner", "moderator", "member"]),
});
export type PutMemberBody = z.infer<typeof PutMemberSchema>;
