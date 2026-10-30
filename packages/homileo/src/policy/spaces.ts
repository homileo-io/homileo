import { hasPermission } from "../utils/permissions.js";
import type { OrgCaller } from "../middleware/auth.js";
import type { SpaceFacts } from "./types.js";

const holdsGrant = (
  c: OrgCaller,
  s: SpaceFacts,
  access: "read" | "moderate"
): boolean =>
  s.kind.grants.some(
    (g) =>
      (access === "read" || g.access === "moderate") &&
      hasPermission(c.permissions, g.permission)
  );

/** Whether the caller holds a grant of the space's kind (any access level). */
export const holdsKindGrant = (c: OrgCaller, s: SpaceFacts): boolean =>
  holdsGrant(c, s, "read");

const sameOrganization = (c: OrgCaller, s: SpaceFacts): boolean =>
  c.organizationId === s.organizationId;

export const canReadSpace = (c: OrgCaller, s: SpaceFacts): boolean =>
  sameOrganization(c, s) &&
  (s.role !== null ||
    s.visibility === "public" ||
    holdsKindGrant(c, s) ||
    c.isAdmin);

export const canModerateSpace = (c: OrgCaller, s: SpaceFacts): boolean =>
  sameOrganization(c, s) &&
  (s.role === "owner" ||
    s.role === "moderator" ||
    holdsGrant(c, s, "moderate") ||
    c.isAdmin);

export const canManageSpace = (c: OrgCaller, s: SpaceFacts): boolean =>
  sameOrganization(c, s) && (s.role === "owner" || c.isAdmin);

export const joinSpaceOutcome = (
  c: OrgCaller,
  s: SpaceFacts
): "join" | "request" | "forbidden" => {
  if (s.archived || !canReadSpace(c, s)) return "forbidden";
  if (s.role !== null) return "join";
  if (s.joinPolicy === "open") return "join";
  if (s.joinPolicy === "request") return "request";
  return "forbidden";
};
