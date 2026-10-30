import { metadataSchema } from "../../../utils/metadata.js";
import { z } from "zod";

const unique = (ids: string[]) => new Set(ids).size === ids.length;

export const CreateSessionBodySchema = z.strictObject({
  spaceId: z.guid().optional(),
  name: z.string().min(1).max(255).optional(),
  access: z.enum(["space", "members"]).optional(),
  participantIds: z
    .array(z.guid())
    .max(100)
    .refine(unique, "ids must be unique")
    .optional(),
  state: z.string().min(1).max(64).optional(),
  externalRef: z.string().min(1).max(255).optional(),
  metadata: metadataSchema.optional(),
});

const booleanParam = z.enum(["true", "false"]).transform((v) => v === "true");

export const ListSessionsQuerySchema = z.strictObject({
  spaceId: z.guid().optional(),
  type: z.enum(["direct", "group"]).optional(),
  externalRef: z.string().min(1).max(255).optional(),
  includeArchived: booleanParam.default(false),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
