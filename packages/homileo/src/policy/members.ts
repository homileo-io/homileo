import { canManageSpace, canModerateSpace } from "./spaces.js";
import type { SpaceFacts, SpaceRole } from "./types.js";
import type { OrgCaller } from "../middleware/auth.js";

/** `from: null` adds, `to: null` removes; `self` is the caller acting on their own membership. */
export type MemberChange = {
  from: SpaceRole | null;
  to: SpaceRole | null;
  self: boolean;
};

/** The last-owner rule is a database check; this only decides who may attempt the change. */
export const canChangeMember = (
  c: OrgCaller,
  s: SpaceFacts,
  change: MemberChange
): boolean => {
  if (c.organizationId !== s.organizationId) return false;
  if (change.self && change.to === null) return s.role !== null || c.isAdmin;
  if (s.archived) return false;
  if (change.from === null) {
    return change.to === "member"
      ? canModerateSpace(c, s)
      : canManageSpace(c, s);
  }
  if (change.to === null && change.from === "member") {
    return canModerateSpace(c, s);
  }
  return canManageSpace(c, s);
};
