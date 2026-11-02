import { hasPermission } from "../utils/permissions.js";
import type { OrgCaller } from "../middleware/auth.js";
import {
  SPACES_READ_PERMISSION,
  SPACES_WRITE_PERMISSION,
} from "../definitions/tereoDeclaration.js";

/**
 * Whether the caller's token lets it use chat at all (every `/v1` route and socket); the
 * resource's own rules still decide what it sees. `homileo.chat.admin` sits on another branch
 * of the ladder, so it is named here rather than implied; it still reads no DM.
 */
export const canReadChat = (c: OrgCaller): boolean =>
  c.isAdmin || hasPermission(c.permissions, SPACES_READ_PERMISSION);

/**
 * Whether the caller's token lets it change shared chat state at all; the
 * resource's own rules still decide each change.
 */
export const canWriteChat = (c: OrgCaller): boolean =>
  c.isAdmin || hasPermission(c.permissions, SPACES_WRITE_PERMISSION);

/** Removing someone from a space or session needs `canWriteChat`; leaving (`targetId` is the caller) does not. */
export const canRemoveWithToken = (c: OrgCaller, targetId: string): boolean =>
  targetId === c.principalId || canWriteChat(c);

/**
 * The read gate for a request that acts only on `targetId`'s own membership or participation
 * (leaving, muting): a caller whose read was revoked can still step out of what it was in.
 */
export const canActOnOwnWithToken = (c: OrgCaller, targetId: string): boolean =>
  targetId === c.principalId || canReadChat(c);

/**
 * Whether a refusal may say why. A caller let into an own-only route without `canReadChat` gets
 * the same plain 404 for every refusal, so what it was refused cannot show what exists.
 */
export const seesRefusalReasons = (c: OrgCaller): boolean => canReadChat(c);
