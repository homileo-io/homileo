import type { Principal } from "../utils/db/principals.js";
import { hasPermission } from "../utils/permissions.js";
import type { RequestHandler, Request } from "express";
import type { AuthContext } from "@tereo-io/sdk";
import { getTereo } from "../utils/tereo.js";
import { db } from "../utils/db/index.js";
import {
  AppError,
  ForbiddenError,
  UnauthorizedError,
} from "../utils/errors.js";

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
      isAdmin: hasPermission(identity.permissions, "homileo.chat.admin"),
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

/** Refuses a caller whose token lacks `permission` (403); needs `authenticate` before it. */
export const requirePermission =
  (permission: string): RequestHandler =>
  (req, _res, next) => {
    try {
      if (!hasPermission(callerOf(req).permissions, permission)) {
        throw new ForbiddenError(`Requires the ${permission} permission`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
