import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

export const ParticipantParamsSchema = z.object({
  sessionId: IdSchema,
  principalId: IdSchema,
});
