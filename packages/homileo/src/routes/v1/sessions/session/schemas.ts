import { metadataSchema } from "../../../../utils/metadata.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const SessionParamsSchema = z.object({ sessionId: IdSchema });

export const UpdateSessionBodySchema = z
  .strictObject({
    name: z.string().min(1).max(255).nullable().optional(),
    state: z.string().min(1).max(64).nullable().optional(),
    externalRef: z.string().min(1).max(255).nullable().optional(),
    metadata: metadataSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Give at least one field");
