import type { ResolvedSpaceKind } from "../definitions/builtins.js";

export type SpaceRole = "owner" | "moderator" | "member";

/** What the policy needs to know about a space; `role` is the caller's membership. */
export interface SpaceFacts {
  organizationId: string;
  kind: ResolvedSpaceKind;
  visibility: "public" | "members";
  joinPolicy: "open" | "request" | "invite";
  postPolicy: "members" | "moderators";
  archived: boolean;
  role: SpaceRole | null;
}

export interface SessionFacts {
  organizationId: string;
  /** `null` for a space-less session (DMs, groups). */
  space: SpaceFacts | null;
  access: "space" | "members";
  archived: boolean;
  participantRole: "owner" | "member" | null;
}

export interface MessageFacts {
  senderId: string;
  createdAt: Date;
  deleted: boolean;
}
