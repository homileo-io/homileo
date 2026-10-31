import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const DirectBodySchema = z.strictObject({ principalId: IdSchema });
