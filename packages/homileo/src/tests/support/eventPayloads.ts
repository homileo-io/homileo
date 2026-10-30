import { v7 as uuidv7 } from "uuid";

const now = () => new Date().toISOString();

export const spacePayload = (spaceId: string = uuidv7()) => ({
  space: {
    id: spaceId,
    organizationId: uuidv7(),
    kind: "test:kind",
    name: "General",
    description: null,
    visibility: "members",
    joinPolicy: "invite",
    postPolicy: "members",
    state: null,
    externalRef: null,
    metadata: {},
    createdBy: uuidv7(),
    createdAt: now(),
    updatedAt: now(),
    archivedAt: null,
  },
});

export const readPayload = () => ({
  principalId: uuidv7(),
  sessionId: uuidv7(),
  threadRootId: null,
  lastReadSeq: 3,
});
