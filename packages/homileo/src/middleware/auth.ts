import { AppError, ForbiddenError } from "../utils/errors.js";
import type { Principal } from "../utils/db/principals.js";
import { hasPermission } from "../utils/permissions.js";
import type { RequestHandler, Request } from "express";
import { getTereo } from "../utils/tereo.js";
import { db } from "../utils/db/index.js";

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

const authenticateAfterTereo: RequestHandler = async (req, _res, next) => {
  try {
    const auth = req.auth!;
    // Refused before a principal is created for it.
    if (!auth.organizationId) {
      throw new AppError(
        400,
        "organization_required",
        "This request needs an organization: use a token that has one"
      );
    }
    const principal = await db.principals.findOrCreateUser({
      tereoUserId: auth.userId,
      isBot: auth.userType === "service_account",
      displayName: auth.name,
    });
    db.principals.refreshProfileInBackground(principal);
    req.principal = principal;
    req.caller = {
      principalId: principal.id,
      tereoUserId: auth.userId,
      isBot: principal.isBot,
      permissions: auth.permissions,
      isAdmin: hasPermission(auth.permissions, "homileo.chat.admin"),
      organizationId: auth.organizationId,
    };
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
