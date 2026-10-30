import { z } from "zod";

export const NotifyBodySchema = z.strictObject({
  notify: z.enum(["all", "mentions", "none"]),
});
