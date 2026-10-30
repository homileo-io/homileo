import { iso, isoOrNull, metadataOf } from "./common.js";
import type {
  Session,
  SessionParticipant,
} from "../../prisma/generated/client/index.js";
import type {
  Participant as ParticipantView,
  Session as SessionView,
} from "@homileo-io/sdk";

export const sessionView = (row: Session): SessionView => ({
  id: row.id,
  organizationId: row.organizationId,
  spaceId: row.spaceId,
  type: row.type,
  access: row.access,
  name: row.name,
  state: row.state,
  lastSeq: Number(row.lastSeq),
  lastMessageAt: isoOrNull(row.lastMessageAt),
  externalRef: row.externalRef,
  metadata: metadataOf(row.metadata),
  createdBy: row.createdBy,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  archivedAt: isoOrNull(row.archivedAt),
});

export const participantView = (row: SessionParticipant): ParticipantView => ({
  sessionId: row.sessionId,
  principalId: row.userId,
  role: row.role,
  lastReadSeq: Number(row.lastReadSeq),
  notify: row.notify,
  joinedAt: iso(row.joinedAt),
});
