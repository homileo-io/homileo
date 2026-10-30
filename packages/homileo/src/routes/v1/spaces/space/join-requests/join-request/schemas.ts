import { z } from "zod";

export const JoinRequestParamsSchema = z.object({
  spaceId: z.guid(),
  principalId: z.guid(),
});
