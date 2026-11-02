import type { ErrorRequestHandler, RequestHandler, Request } from "express";
import type { Principal } from "../utils/db/principals.js";
import { hasPermission } from "../utils/permissions.js";
import type { AuthContext } from "@tereo-io/sdk";
import { IdSchema } from "../utils/idSchema.js";
import { getTereo } from "../utils/tereo.js";
import { db } from "../utils/db/index.js";
import {
  CHAT_ADMIN_PERMISSION,
  SPACES_READ_PERMISSION,
  SPACES_WRITE_PERMISSION,
} from "../definitions/tereoDeclaration.js";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../utils/errors.js";
import {
  canActOnOwnWithToken,
  canRemoveWithToken,
  canWriteChat,
  canReadChat,
  seesRefusalReasons,
} from "../policy/chat.js";

export interface Caller {
  principalId: string;
  tereoUserId: string;
  isBot: boolean;
  permissions: string[];
  /** `homileo.chat.admin`. */
  isAdmin: boolean;
  /** From the token's `org_id`: every `/v1` request has one. */
  organizationId: string;
}
/** What `src/policy` takes; every caller has an organization. */
export type OrgCaller = Caller;

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
      /** The caller's principal row, as `authenticate` loaded it. */
      principal?: Principal;
    }
  }
}

/** The token's identity, as `requireAuth` reads it into `req.auth`. */
type TokenIdentity = Pick<
  AuthContext,
  "userId" | "userType" | "name" | "permissions" | "organizationId"
>;

const organizationRequired = () =>
  new AppError(
    400,
    "organization_required",
    "This request needs an organization: use a token that has one"
  );

/** Finds or creates the token's principal and builds its caller; refuses a token without an organization. */
const callerOfIdentity = async (
  identity: TokenIdentity
): Promise<{ caller: Caller; principal: Principal }> => {
  // Refused before a principal is created for it.
  if (!identity.organizationId) throw organizationRequired();
  const principal = await db.principals.findOrCreateUser({
    tereoUserId: identity.userId,
    isBot: identity.userType === "service_account",
    displayName: identity.name,
  });
  db.principals.refreshProfileInBackground(principal);
  return {
    principal,
    caller: {
      principalId: principal.id,
      tereoUserId: identity.userId,
      isBot: principal.isBot,
      permissions: identity.permissions,
      isAdmin: hasPermission(identity.permissions, CHAT_ADMIN_PERMISSION),
      organizationId: identity.organizationId,
    },
  };
};

/**
 * Introspects `token` with tereo, as `authenticate` does for a request: refuses an inactive
 * token (`UnauthorizedError`) or one without `org_id` (`organization_required`). `exp` is the
 * token's expiry in seconds since the epoch.
 */
export const callerFromToken = async (
  token: string
): Promise<{ caller: Caller; principal: Principal; exp: number | null }> => {
  const res = await getTereo().auth.introspectToken(token);
  if (!res.active) throw new UnauthorizedError("Invalid or expired token");
  const { caller, principal } = await callerOfIdentity({
    userId: res.user_id,
    // As the SDK's `requireAuth` tells them apart: a client_credentials token's `sub` is its client.
    userType:
      res.sub && res.sub !== res.client_id ? "human" : "service_account",
    name: res.name || null,
    permissions: res.permissions || [],
    organizationId: res.org_id || null,
  });
  return { caller, principal, exp: res.exp ?? null };
};

const authenticateAfterTereo: RequestHandler = async (req, _res, next) => {
  try {
    const { caller, principal } = await callerOfIdentity(req.auth!);
    req.principal = principal;
    req.caller = caller;
    next();
  } catch (err) {
    next(err);
  }
};

/** Verifies the token with tereo, refuses one without `org_id` (400 `organization_required`), then sets `req.caller`. */
export const authenticate: RequestHandler = (req, res, next) => {
  void getTereo().auth.requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    void authenticateAfterTereo(req, res, next);
  });
};

export const callerOf = (req: Request): Caller => {
  if (!req.caller) throw new Error("callerOf used before authenticate");
  return req.caller;
};

export const principalOf = (req: Request): Principal => {
  if (!req.principal) throw new Error("principalOf used before authenticate");
  return req.principal;
};

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The `/v1` routes that act only on one principal's own membership or participation, and where
 * that principal is: a path segment, or the caller itself. Case-insensitive with an optional
 * trailing slash, as Express routes; any other spelling of the path stays read-gated.
 */
const OWN_ONLY_ROUTES: readonly {
  method: string;
  path: RegExp;
  target: "caller" | number;
}[] = [
  {
    method: "DELETE",
    path: new RegExp(`^/spaces/${GUID}/members/(${GUID})/?$`, "i"),
    target: 1,
  },
  {
    method: "DELETE",
    path: new RegExp(`^/sessions/${GUID}/participants/(${GUID})/?$`, "i"),
    target: 1,
  },
  {
    method: "PUT",
    path: new RegExp(`^/sessions/${GUID}/notify/?$`, "i"),
    target: "caller",
  },
];

/** The principal an own-only route acts on, or null when the request is not one. */
const ownOnlyTarget = (req: Request, caller: Caller): string | null => {
  for (const route of OWN_ONLY_ROUTES) {
    if (req.method !== route.method) continue;
    const match = route.path.exec(req.path);
    if (!match) continue;
    return route.target === "caller"
      ? caller.principalId
      : match[route.target]!.toLowerCase();
  }
  return null;
};

/**
 * Refuses (403) a caller whose token may not use chat (`canReadChat`), except on a route that
 * leaves or mutes the caller's own membership (`canActOnOwnWithToken`). Mounted once on `/v1`,
 * where `req.path` is relative to it; needs `authenticate` before it.
 */
export const requireChatReadUnlessSelf: RequestHandler = (req, _res, next) => {
  try {
    const caller = callerOf(req);
    const target = ownOnlyTarget(req, caller);
    const allowed =
      target === null
        ? canReadChat(caller)
        : canActOnOwnWithToken(caller, target);
    if (!allowed) {
      throw new ForbiddenError(
        `Requires the ${SPACES_READ_PERMISSION} permission`
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Error middleware for `/v1`, after its routes: a request let through `requireChatReadUnlessSelf`
 * only because it acts on the caller's own membership gets one plain 404 for any refusal
 * (`seesRefusalReasons`), whether the space, session, member or participant was missing.
 */
export const hideRefusalsUnlessReader: ErrorRequestHandler = (
  err,
  req,
  _res,
  next
) => {
  const caller = req.caller;
  const hide =
    caller !== undefined &&
    err instanceof AppError &&
    err.statusCode < 500 &&
    !seesRefusalReasons(caller) &&
    ownOnlyTarget(req, caller) === caller.principalId;
  next(hide ? new NotFoundError() : err);
};

/** Refuses (403) a caller whose token may only read chat (`canWriteChat`); needs `authenticate` before it. */
export const requireChatWrite: RequestHandler = (req, _res, next) => {
  try {
    if (!canWriteChat(callerOf(req))) {
      throw new ForbiddenError(
        `Requires the ${SPACES_WRITE_PERMISSION} permission`
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** `requireChatWrite` for a removal route: a read-only caller may still remove itself (`:principalId`). */
export const requireChatWriteUnlessSelf: RequestHandler = (req, _res, next) => {
  try {
    // As the route's params schema will read it, so an upper-case own id is still the caller.
    const target = IdSchema.safeParse(req.params.principalId);
    const targetId = target.success ? target.data : "";
    if (!canRemoveWithToken(callerOf(req), targetId)) {
      throw new ForbiddenError(
        `Requires the ${SPACES_WRITE_PERMISSION} permission`
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};
