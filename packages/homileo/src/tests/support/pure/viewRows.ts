export const id = (n: number) =>
  `0194c0de-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const at = new Date("2026-10-30T12:00:00.000Z");

export const principalRow = {
  id: id(1),
  kind: "user" as const,
  tereoUserId: id(2),
  app: null,
  externalId: null,
  isBot: false,
  displayName: "Ada",
  avatarUrl: null,
  profileRefreshedAt: at,
  createdAt: at,
  updatedAt: at,
};

export const spaceRow = {
  id: id(3),
  organizationId: id(4),
  kind: "acme:project",
  name: "General",
  description: null,
  visibility: "members" as const,
  joinPolicy: "invite" as const,
  postPolicy: "members" as const,
  state: null,
  externalRef: null,
  metadata: { color: "red" },
  createdBy: id(1),
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const sessionRow = {
  id: id(6),
  organizationId: id(4),
  spaceId: id(3),
  type: "group" as const,
  access: "space" as const,
  name: "Kickoff",
  state: null,
  lastSeq: 12n,
  lastMessageAt: at,
  directKey: null,
  externalRef: null,
  metadata: {},
  createdBy: id(1),
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
};

export const messageRow = {
  id: id(8),
  sessionId: id(6),
  seq: 12n,
  senderId: id(1),
  clientMessageId: "c-1",
  type: "text",
  body: "hello",
  bodyText: "hello",
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
  attachments: [
    {
      id: id(7),
      messageId: id(8),
      tereoObjectId: "obj",
      filename: "a.png",
      contentType: "image/png",
      size: 2048n,
      position: 0,
    },
  ],
  reactions: [{ emoji: "👍", count: 1, principalIds: [id(1)] }],
};
