import { Id, Metadata, Timestamp } from "./common.js";
import { z } from "zod";

export const SessionSchema = z.strictObject({
  id: Id,
  organizationId: Id,
  spaceId: Id.nullable(),
  type: z.enum(["direct", "group"]),
  access: z.enum(["space", "members"]),
  name: z.string().nullable(),
  state: z.string().nullable(),
  lastSeq: z.number().int(),
  lastMessageAt: Timestamp.nullable(),
  externalRef: z.string().nullable(),
  metadata: Metadata,
  createdBy: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});

export const ParticipantSchema = z.strictObject({
  sessionId: Id,
  principalId: Id,
  role: z.enum(["owner", "member"]),
  lastReadSeq: z.number().int(),
  notify: z.enum(["all", "mentions", "none"]),
  joinedAt: Timestamp,
});

export type Session = z.infer<typeof SessionSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;
