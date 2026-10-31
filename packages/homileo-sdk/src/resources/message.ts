import { Id, Metadata, Timestamp } from "./common.js";
import { z } from "zod";

export const AttachmentSchema = z.strictObject({
  id: Id,
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  position: z.number().int(),
});

/** `principalIds` holds the first 50 reactors by `created_at`. */
export const ReactionSummarySchema = z.strictObject({
  emoji: z.string(),
  count: z.number().int(),
  principalIds: z.array(Id),
});

export const MessageSchema = z.strictObject({
  id: Id,
  sessionId: Id,
  seq: z.number().int(),
  senderId: Id,
  clientMessageId: z.string(),
  type: z.string(),
  body: z.string().nullable(),
  payload: z.unknown().nullable(),
  metadata: Metadata,
  threadRootId: Id.nullable(),
  replyCount: z.number().int(),
  lastReplyAt: Timestamp.nullable(),
  revision: z.number().int(),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
  deletedAt: Timestamp.nullable(),
  deletedBy: Id.nullable(),
  attachments: z.array(AttachmentSchema),
  reactions: z.array(ReactionSummarySchema),
});

export const MessageRevisionSchema = z.strictObject({
  revision: z.number().int(),
  body: z.string().nullable(),
  payload: z.unknown().nullable(),
  editedBy: Id,
  editedAt: Timestamp,
});

export type Attachment = z.infer<typeof AttachmentSchema>;
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageRevision = z.infer<typeof MessageRevisionSchema>;
