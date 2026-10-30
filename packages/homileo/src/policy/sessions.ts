import { canModerateSpace, canReadSpace, holdsKindGrant } from "./spaces.js";
import type { SessionFacts, SpaceFacts } from "./types.js";
import type { OrgCaller } from "../middleware/auth.js";

/** A session and its space (if any) must both be in the caller's organization. */
const sameOrganization = (c: OrgCaller, ss: SessionFacts): boolean =>
  c.organizationId === ss.organizationId &&
  (ss.space === null || ss.space.organizationId === ss.organizationId);

export const canReadSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!sameOrganization(c, ss)) return false;
  if (ss.space === null) return ss.participantRole !== null;
  if (ss.access === "space") return canReadSpace(c, ss.space);
  return (
    ss.participantRole !== null || holdsKindGrant(c, ss.space) || c.isAdmin
  );
};

/** Whether the caller may make themselves a participant of an `access: space` session. */
export const canJoinSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!sameOrganization(c, ss) || ss.archived) return false;
  if (ss.space === null || ss.access !== "space") return false;
  if (ss.space.archived || !canReadSpace(c, ss.space)) return false;
  if (ss.participantRole !== null || ss.space.role !== null) return true;
  return ss.space.joinPolicy === "open";
};

export const canPost = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!sameOrganization(c, ss) || ss.archived) return false;
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
  if (!sameOrganization(c, ss) || ss.archived) return false;
  if (ss.type === "direct") return false;
  if (ss.space === null) return ss.participantRole === "owner";
  return canChangeSpaceParticipants(c, ss.space);
};

/** In a space-less session the `owner` or `homileo.chat.admin` removes; a DM has no `owner`. */
export const canRemoveParticipant = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => {
  if (!sameOrganization(c, ss) || ss.archived) return false;
  if (ss.space === null) return ss.participantRole === "owner" || c.isAdmin;
  return canChangeSpaceParticipants(c, ss.space);
};

/** In a space, who moderates it; in a space-less group its `owner` or an admin; a DM, only an admin. */
export const canArchiveSession = (c: OrgCaller, ss: SessionFacts): boolean => {
  if (!sameOrganization(c, ss)) return false;
  if (ss.space !== null) return canModerateSpace(c, ss.space);
  if (ss.type === "direct") return c.isAdmin;
  return ss.participantRole === "owner" || c.isAdmin;
};

/**
 * Anyone in a session can leave it, archived or not, except in a DM, which always has its two
 * participants.
 */
export const canLeaveSession = (c: OrgCaller, ss: SessionFacts): boolean =>
  sameOrganization(c, ss) &&
  ss.participantRole !== null &&
  ss.type !== "direct";

/** Reacting needs participation and a writable session, but not the space's post policy. */
export const canReact = (c: OrgCaller, ss: SessionFacts): boolean =>
  sameOrganization(c, ss) &&
  ss.participantRole !== null &&
  !ss.archived &&
  !(ss.space?.archived ?? false) &&
  canReadSession(c, ss);

/** Rename, metadata, `externalRef` and `state`. A DM has nothing to edit. */
export const canEditSessionSettings = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => {
  if (!sameOrganization(c, ss) || ss.archived || ss.type === "direct") {
    return false;
  }
  if (ss.space !== null)
    return !ss.space.archived && canModerateSpace(c, ss.space);
  return ss.participantRole === "owner";
};

/** Starting a session in a space: members (or moderators) of an unarchived space; moderators only when posting is restricted. */
export const canCreateSessionIn = (c: OrgCaller, s: SpaceFacts): boolean => {
  if (c.organizationId !== s.organizationId || s.archived) return false;
  if (s.role === null && !canModerateSpace(c, s)) return false;
  return s.postPolicy !== "moderators" || canModerateSpace(c, s);
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
