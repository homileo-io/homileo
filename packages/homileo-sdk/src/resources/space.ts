import { Id, Metadata, Timestamp } from "./common.js";
import { z } from "zod";

export const SpaceSchema = z.strictObject({
  id: Id,
  organizationId: Id,
  kind: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  visibility: z.enum(["public", "members"]),
  joinPolicy: z.enum(["open", "request", "invite"]),
  postPolicy: z.enum(["members", "moderators"]),
  state: z.string().nullable(),
  externalRef: z.string().nullable(),
  metadata: Metadata,
  createdBy: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});

export const SpaceRoleSchema = z.enum(["owner", "moderator", "member"]);

export const SpaceMemberSchema = z.strictObject({
  spaceId: Id,
  principalId: Id,
  role: SpaceRoleSchema,
  joinedAt: Timestamp,
});

export const JoinRequestSchema = z.strictObject({
  id: Id,
  spaceId: Id,
  principalId: Id,
  status: z.enum(["pending", "approved", "denied"]),
  createdAt: Timestamp,
  decidedBy: Id.nullable(),
  decidedAt: Timestamp.nullable(),
});

export type Space = z.infer<typeof SpaceSchema>;
export type SpaceRole = z.infer<typeof SpaceRoleSchema>;
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;
export type JoinRequest = z.infer<typeof JoinRequestSchema>;
