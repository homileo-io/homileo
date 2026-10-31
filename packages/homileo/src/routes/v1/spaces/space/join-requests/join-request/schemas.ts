import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

export const JoinRequestParamsSchema = z.object({
  spaceId: IdSchema,
  principalId: IdSchema,
});
