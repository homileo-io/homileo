import { z } from "zod";

export const MemberParamsSchema = z.object({
  spaceId: z.guid(),
  principalId: z.guid(),
});

export const PutMemberSchema = z.strictObject({
  role: z.enum(["owner", "moderator", "member"]),
});
export type PutMemberBody = z.infer<typeof PutMemberSchema>;
