import { Id } from "./common.js";
import { z } from "zod";

export const PrincipalSchema = z.strictObject({
  id: Id,
  kind: z.enum(["user", "external"]),
  tereoUserId: Id.nullable(),
  isBot: z.boolean(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export type Principal = z.infer<typeof PrincipalSchema>;
