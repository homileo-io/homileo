import { canModerateSpace, canReadSpace, holdsKindGrant } from "./spaces.js";
import type { SessionFacts, SpaceFacts } from "./types.js";
import type { OrgCaller } from "../middleware/auth.js";

/** A session and its space (if any) must both be in the caller's organization. */
export const inSessionOrganization = (
  c: OrgCaller,
  ss: SessionFacts
): boolean =>
  c.organizationId === ss.organizationId &&
  (ss.space === null || ss.space.organizationId === ss.organizationId);

/**
 * Whether a caller who can read the space reads every session in it, `access: members` ones
 * included, without being their participant.
 */
export const readsEverySessionOf = (c: OrgCaller, s: SpaceFacts): boolean =>
  holdsKindGrant(c, s) || c.isAdmin;

/** Session access only narrows the space's: a session in a space needs read on the space. */
export const canReadSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!inSessionOrganization(c, ss)) return false;
  if (ss.space === null) return ss.participantRole !== null;
  if (!canReadSpace(c, ss.space)) return false;
  if (ss.access === "space") return true;
  return ss.participantRole !== null || readsEverySessionOf(c, ss.space);
};

/**
 * A session its space's readers cannot all read: a space-less one (DMs, groups) or an
 * `access: members` one. Its webhook events need `homileo.messages.read_private`.
 */
export const isPrivateSession = (ss: {
  spaceId: string | null;
  access: "space" | "members";
}): boolean => ss.spaceId === null || ss.access !== "space";

/** Whether the caller may make themselves a participant of an `access: space` session. */
export const canJoinSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!inSessionOrganization(c, ss) || ss.archived) return false;
  if (ss.space === null || ss.access !== "space") return false;
  if (ss.space.archived || !canReadSpace(c, ss.space)) return false;
  if (ss.participantRole !== null || ss.space.role !== null) return true;
  return ss.space.joinPolicy === "open";
};

export const canPost = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!inSessionOrganization(c, ss) || ss.archived) return false;
  if (ss.participantRole === null || !canReadSession(c, ss)) return false;
  if (ss.space === null) return true;
  if (ss.space.archived) return false;
  if (ss.space.postPolicy === "moderators") {
    return canModerateSpace(c, ss.space);
  }
  return true;
};

/** In a space's session, whoever can moderate the space adds and removes participants. */
const canChangeSpaceParticipants = (c: OrgCaller, space: SpaceFacts): boolean =>
  !space.archived && canModerateSpace(c, space);

/**
 * A DM has exactly its two participants, so nobody adds to one. In a space-less group only its
 * `owner` adds: an admin who could add themselves could then read the session.
 */
export const canAddParticipant = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!inSessionOrganization(c, ss) || ss.archived) return false;
  if (ss.type === "direct") return false;
  if (ss.space === null) return ss.participantRole === "owner";
  return canChangeSpaceParticipants(c, ss.space);
};

/** In a space-less session the `owner` or `homileo.chat.admin` removes; a DM has no `owner`. */
export const canRemoveParticipant = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => {
  if (!inSessionOrganization(c, ss) || ss.archived) return false;
  if (ss.space === null) return ss.participantRole === "owner" || c.isAdmin;
  return canChangeSpaceParticipants(c, ss.space);
};

/** In a space, who moderates it; in a space-less group its `owner` or an admin; a DM, only an admin. */
export const canArchiveSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!inSessionOrganization(c, ss)) return false;
  if (ss.space !== null) return canModerateSpace(c, ss.space);
  if (ss.type === "direct") return c.isAdmin;
  return ss.participantRole === "owner" || c.isAdmin;
};

/**
 * Anyone in a session can leave it, archived or not, except in a DM, which always has its two
 * participants.
 */
export const canLeaveSession = (c: OrgCaller, ss: SessionFacts): boolean =>
  inSessionOrganization(c, ss) &&
  ss.participantRole !== null &&
  ss.type !== "direct";

/**
 * Whom archiving and removing participants load a session for without the read check: an admin
 * of its organization, and in a space whoever moderates the space. The action's own rule still
 * decides.
 */
export const managesWithoutReading = (
  c: OrgCaller,
  ss: SessionFacts
): boolean =>
  (ss.space === null && inSessionOrganization(c, ss) && c.isAdmin) ||
  moderatesWithoutReading(c, ss);

/** Whoever moderates the session's space; the content of a space-less session has no moderator. */
export const moderatesWithoutReading = (
  c: OrgCaller,
  ss: SessionFacts
): boolean =>
  inSessionOrganization(c, ss) &&
  ss.space !== null &&
  canModerateSpace(c, ss.space);

/**
 * Leaving and muting change only the caller's own participant row, so a participant who lost read
 * (and still gets mentions and notifications as one) can do both.
 */
export const actsOnOwnParticipation = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => inSessionOrganization(c, ss) && ss.participantRole !== null;

/** Reacting needs participation and a writable session, but not the space's post policy. */
export const canReact = (c: OrgCaller, ss: SessionFacts): boolean =>
  reactRefusal(c, ss) === null;

/** Rename, metadata, `externalRef` and `state`. A DM has nothing to edit. */
export const canEditSessionSettings = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => {
  if (!inSessionOrganization(c, ss) || ss.archived || ss.type === "direct") {
    return false;
  }
  if (ss.space !== null)
    return !ss.space.archived && canModerateSpace(c, ss.space);
  return ss.participantRole === "owner";
};

/** Starting a session in a space: members (or moderators) of an unarchived space; moderators only when posting is restricted. */
export const canCreateSessionIn = (c: OrgCaller, s: SpaceFacts): boolean =>
  createSessionRefusal(c, s) === null;

export type CreateSessionRefusal =
  "not_found" | "archived" | "posting_restricted" | "not_a_member";

/** The first reason `canCreateSessionIn` would be false, or `null` when it is true. */
export const createSessionRefusal = (
  c: OrgCaller,
  s: SpaceFacts
): CreateSessionRefusal | null => {
  if (c.organizationId !== s.organizationId) return "not_found";
  if (s.archived) return "archived";
  const moderates = canModerateSpace(c, s);
  if (s.postPolicy === "moderators" && !moderates) return "posting_restricted";
  if (s.role === null && !moderates) return "not_a_member";
  return null;
};

export type PostRefusal =
  "not_found" | "archived" | "not_a_participant" | "posting_restricted";

/** The first reason `canPost` would be false, or `null` when it is true. */
export const postRefusal = (
  c: OrgCaller,
  ss: SessionFacts
): PostRefusal | null => {
  if (!canReadSession(c, ss)) return "not_found";
  if (ss.archived || (ss.space?.archived ?? false)) return "archived";
  if (ss.participantRole === null) return "not_a_participant";
  if (ss.space?.postPolicy === "moderators" && !canModerateSpace(c, ss.space)) {
    return "posting_restricted";
  }
  return null;
};

export type ReactRefusal = Exclude<PostRefusal, "posting_restricted">;

/** The first reason `canReact` would be false, or `null` when it is true. */
export const reactRefusal = (
  c: OrgCaller,
  ss: SessionFacts
): ReactRefusal | null => {
  if (!canReadSession(c, ss)) return "not_found";
  if (ss.archived || (ss.space?.archived ?? false)) return "archived";
  if (ss.participantRole === null) return "not_a_participant";
  return null;
};
