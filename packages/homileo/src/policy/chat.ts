import { SPACES_WRITE_PERMISSION } from "../definitions/tereoDeclaration.js";
import { hasPermission } from "../utils/permissions.js";
import type { OrgCaller } from "../middleware/auth.js";

/**
 * Whether the caller's token lets it change shared chat state at all; the
 * resource's own rules still decide each change. `homileo.chat.admin` sits on
 * another branch of the ladder, so it is named here rather than implied.
 */
export const canWriteChat = (c: OrgCaller): boolean =>
  c.isAdmin || hasPermission(c.permissions, SPACES_WRITE_PERMISSION);
