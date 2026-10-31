import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

/** Comma-separated ids, at most 50, repeats dropped. */
const IdList = z
  .string()
  .transform((s) => s.split(","))
  .pipe(z.array(IdSchema).max(50))
  .transform((ids) => [...new Set(ids)]);

export const SyncQuerySchema = z.strictObject({
  /** The `next` of the previous response. */
  since: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  sessionIds: IdList.default([]),
  spaceIds: IdList.default([]),
});
