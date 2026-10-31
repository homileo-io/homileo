import { iso, isoOrNull, metadataOf } from "./common.js";
import type {
  Attachment,
  Message,
  MessageRevision,
} from "../../prisma/generated/client/index.js";
import type {
  MessageRevision as MessageRevisionView,
  ReactionSummary,
  Message as MessageView,
} from "@homileo-io/sdk";

export type MessageRow = Message & {
  attachments: Attachment[];
  reactions: ReactionSummary[];
};

export const messageView = (row: MessageRow): MessageView => {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: Number(row.seq),
    senderId: row.senderId,
    clientMessageId: row.clientMessageId,
    type: row.type,
    body: row.body,
    payload: row.payload,
    metadata: metadataOf(row.metadata),
    threadRootId: row.threadRootId,
    replyCount: row.replyCount,
    lastReplyAt: isoOrNull(row.lastReplyAt),
    revision: row.revision,
    createdAt: iso(row.createdAt),
    editedAt: isoOrNull(row.editedAt),
    deletedAt: isoOrNull(row.deletedAt),
    deletedBy: row.deletedBy,
    attachments: deleted
      ? []
      : row.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          contentType: a.contentType,
          size: Number(a.size),
          position: a.position,
        })),
    reactions: deleted ? [] : row.reactions,
  };
};

export const revisionView = (row: MessageRevision): MessageRevisionView => ({
  revision: row.revision,
  body: row.body,
  payload: row.payload,
  editedBy: row.editedBy,
  editedAt: iso(row.editedAt),
});
