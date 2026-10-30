import { z } from "zod";

export const ThreadQuerySchema = z.strictObject({
  after: z
    .string()
    .regex(/^\d{1,15}$/, "A non-negative integer")
    .transform(Number)
    .default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
