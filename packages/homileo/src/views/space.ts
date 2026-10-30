import { iso, isoOrNull, metadataOf } from "./common.js";
import type {
  Space,
  SpaceJoinRequest,
  SpaceMember,
} from "../../prisma/generated/client/index.js";
import type {
  JoinRequest as JoinRequestView,
  SpaceMember as SpaceMemberView,
  Space as SpaceView,
} from "@homileo-io/sdk";

export const spaceView = (row: Space): SpaceView => ({
  id: row.id,
  organizationId: row.organizationId,
  kind: row.kind,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  joinPolicy: row.joinPolicy,
  postPolicy: row.postPolicy,
  state: row.state,
  externalRef: row.externalRef,
  metadata: metadataOf(row.metadata),
  createdBy: row.createdBy,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  archivedAt: isoOrNull(row.archivedAt),
});

export const memberView = (row: SpaceMember): SpaceMemberView => ({
  spaceId: row.spaceId,
  principalId: row.userId,
  role: row.role,
  joinedAt: iso(row.joinedAt),
});

export const joinRequestView = (row: SpaceJoinRequest): JoinRequestView => ({
  id: row.id,
  spaceId: row.spaceId,
  principalId: row.userId,
  status: row.status,
  createdAt: iso(row.createdAt),
  decidedBy: row.decidedBy,
  decidedAt: isoOrNull(row.decidedAt),
});
