import { z } from "zod";

export const ThreadReadBodySchema = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
