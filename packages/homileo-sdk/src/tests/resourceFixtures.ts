const id = (n: number) =>
  `0194c0de-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-30T12:00:00.000Z";

export const principal = {
  id: id(1),
  kind: "user",
  tereoUserId: id(2),
  isBot: false,
  displayName: "Ada",
  avatarUrl: null,
};

export const space = {
  id: id(3),
  organizationId: id(4),
  kind: "acme:project",
  name: "General",
  description: null,
  visibility: "members",
  joinPolicy: "invite",
  postPolicy: "members",
  state: null,
  externalRef: null,
  metadata: { color: "red" },
  createdBy: id(1),
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const spaceMember = {
  spaceId: id(3),
  principalId: id(1),
  role: "owner",
  joinedAt: at,
};

export const joinRequest = {
  id: id(5),
  spaceId: id(3),
  principalId: id(1),
  status: "pending",
  createdAt: at,
  decidedBy: null,
  decidedAt: null,
};

export const session = {
  id: id(6),
  organizationId: id(4),
  spaceId: id(3),
  type: "group",
  access: "space",
  name: "Kickoff",
  state: null,
  lastSeq: 12,
  lastMessageAt: at,
  externalRef: null,
  metadata: {},
  createdBy: id(1),
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const participant = {
  sessionId: id(6),
  principalId: id(1),
  role: "owner",
  lastReadSeq: 3,
  notify: "all",
  joinedAt: at,
};

export const attachment = {
  id: id(7),
  filename: "a.png",
  contentType: "image/png",
  size: 2048,
  position: 0,
};

export const reactionSummary = {
  emoji: "👍",
  count: 1,
  principalIds: [id(1)],
};

export const message = {
  id: id(8),
  sessionId: id(6),
  seq: 12,
  senderId: id(1),
  clientMessageId: "c-1",
  type: "text",
  body: "hello",
  payload: null,
  metadata: {},
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  revision: 1,
  createdAt: at,
  editedAt: null,
  deletedAt: null,
  deletedBy: null,
  attachments: [attachment],
  reactions: [reactionSummary],
};

export const messageRevision = {
  revision: 1,
  body: "hello",
  payload: null,
  editedBy: id(1),
  editedAt: at,
};

export const EVENT_EXAMPLES: Record<string, unknown> = {
  "space.created": { space },
  "space.updated": { space },
  "space.archived": { space },
  "space.member_added": { spaceId: id(3), member: spaceMember },
  "space.member_removed": { spaceId: id(3), principalId: id(1) },
  "space.member_role_changed": {
    spaceId: id(3),
    member: spaceMember,
    previousRole: "member",
  },
  "space.join_requested": { request: joinRequest },
  "space.join_decided": { request: joinRequest },
  "session.created": { session },
  "session.updated": { session },
  "session.archived": { session },
  "session.participant_added": { sessionId: id(6), participant },
  "session.participant_removed": { sessionId: id(6), principalId: id(1) },
  "message.created": { message },
  "message.edited": { message },
  "message.deleted": { message },
  "reaction.added": {
    sessionId: id(6),
    messageId: id(8),
    principalId: id(1),
    emoji: "👍",
  },
  "reaction.removed": {
    sessionId: id(6),
    messageId: id(8),
    principalId: id(1),
    emoji: "👍",
  },
  "thread.updated": {
    sessionId: id(6),
    rootId: id(8),
    replyCount: 2,
    lastReplyAt: at,
  },
  "read.updated": {
    principalId: id(1),
    sessionId: id(6),
    threadRootId: null,
    lastReadSeq: 12,
  },
  "space.access_revoked": { principalId: id(1), spaceId: id(3) },
  "session.access_revoked": { principalId: id(1), sessionId: id(6) },
};
