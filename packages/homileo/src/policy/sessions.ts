import { canModerateSpace, canReadSpace, holdsKindGrant } from "./spaces.js";
import type { OrgCaller } from "../middleware/auth.js";
import type { SessionFacts } from "./types.js";

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
  if (ss.participantRole === null) return false;
  if (ss.space === null) return true;
  if (ss.space.archived) return false;
  if (ss.space.postPolicy === "moderators") {
    return ss.space.role === "owner" || ss.space.role === "moderator";
  }
  return true;
};

export const canManageParticipants = (
  c: OrgCaller,
  ss: SessionFacts
): boolean => {
  if (!sameOrganization(c, ss) || ss.archived) return false;
  if (ss.space === null) return ss.participantRole === "owner";
  return !ss.space.archived && canModerateSpace(c, ss.space);
};
