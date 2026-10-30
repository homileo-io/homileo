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
