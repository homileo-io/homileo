import { z } from "zod";

export const ResolveBodySchema = z.strictObject({
  tereoUserIds: z
    .array(z.guid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, "ids must be unique"),
});
