import { CursorDateSchema } from "../../../utils/cursor.js";
import { metadataSchema } from "../../../utils/metadata.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

const Name = z.string().trim().min(1).max(255);
const Description = z.string().max(10_000).nullable();
const Visibility = z.enum(["public", "members"]);
const JoinPolicy = z.enum(["open", "request", "invite"]);
const PostPolicy = z.enum(["members", "moderators"]);
const State = z.string().min(1).max(64).nullable();
const ExternalRef = z.string().min(1).max(255).nullable();

/** The editable fields, shared by create and update. */
export const SpaceFieldsShape = {
  name: Name,
  description: Description,
  visibility: Visibility,
  joinPolicy: JoinPolicy,
  postPolicy: PostPolicy,
  state: State,
  externalRef: ExternalRef,
  metadata: metadataSchema,
};

export const CreateSpaceSchema = z.strictObject({
  kind: z.string().min(1).max(64).optional(),
  name: Name,
  description: Description.optional(),
  visibility: Visibility.optional(),
  joinPolicy: JoinPolicy.optional(),
  postPolicy: PostPolicy.optional(),
  state: State.optional(),
  externalRef: ExternalRef.optional(),
  metadata: metadataSchema.optional(),
});
export type CreateSpaceBody = z.infer<typeof CreateSpaceSchema>;

export const ListSpacesQuerySchema = z.strictObject({
  kind: z.string().min(1).max(64).optional(),
  externalRef: z.string().min(1).max(255).optional(),
  membership: z.enum(["member", "readable"]).default("member"),
  includeArchived: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListSpacesQuery = z.infer<typeof ListSpacesQuerySchema>;

/** A list cursor's values: `created_at` as an ISO string, then the id. */
export const SpaceCursorSchema = z.tuple([CursorDateSchema, IdSchema]);
