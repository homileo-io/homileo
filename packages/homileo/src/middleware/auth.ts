import type { AuthServiceOrganization } from "@tereo-io/sdk";
import { AppError, NotFoundError } from "../utils/errors.js";
import { validateHeaders } from "../utils/validateReq.js";
import { hasPermission } from "../utils/permissions.js";
import type { RequestHandler, Request } from "express";
import { getTereo } from "../utils/tereo.js";
import { db } from "../utils/db/index.js";
import { z } from "zod";

export interface Caller {
  principalId: string;
  tereoUserId: string;
  isBot: boolean;
  permissions: string[];
  /** `homileo.chat.admin`. */
  isAdmin: boolean;
  organizationId: string | null;
}
export interface OrgCaller extends Caller {
  organizationId: string;
}

declare global {
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

type OrganizationLookup = (
  id: string
) => Promise<AuthServiceOrganization | null>;

let lookupOrganization: OrganizationLookup = (id) =>
  getTereo().auth.getOrganization(id);

/** Replaces tereo's organization lookup; `null` restores it. Only tests call this. */
export const setOrganizationLookup = (lookup: OrganizationLookup | null) => {
  lookupOrganization = lookup ?? ((id) => getTereo().auth.getOrganization(id));
};

const headersSchema = z.object({
  "x-organization-id": z.string().uuid().optional(),
});

/**
 * Only a service account without an organization in its token names one per
 * request; everyone else's header is ignored, not validated.
 */
const resolveOrganization = async (req: Request): Promise<string | null> => {
  const auth = req.auth!;
  if (auth.organizationId) return auth.organizationId;
  if (auth.userType !== "service_account") return null;

  const named = validateHeaders(headersSchema, req)["x-organization-id"];
  if (!named) return null;
  if (!(await lookupOrganization(named))) {
    throw new NotFoundError("Organization not found");
  }
  return named;
};

const authenticateAfterTereo: RequestHandler = async (req, _res, next) => {
  try {
    const auth = req.auth!;
    const organizationId = await resolveOrganization(req);
    const principal = await db.principals.refreshProfile(
      await db.principals.upsertUser({
        tereoUserId: auth.userId,
        isBot: auth.userType === "service_account",
      })
    );
    req.caller = {
      principalId: principal.id,
      tereoUserId: auth.userId,
      isBot: principal.isBot,
      permissions: auth.permissions,
      isAdmin: hasPermission(auth.permissions, "homileo.chat.admin"),
      organizationId,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/** Verifies the token with tereo, then sets `req.caller`. */
export const authenticate: RequestHandler = (req, res, next) => {
  void getTereo().auth.requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    void authenticateAfterTereo(req, res, next);
  });
};

export const requireOrganization: RequestHandler = (req, _res, next) => {
  if (!callerOf(req).organizationId) {
    throw new AppError(
      400,
      "organization_required",
      "This request needs an organization: use a token with one, or send X-Organization-ID"
    );
  }
  next();
};

export const callerOf = (req: Request): Caller => {
  if (!req.caller) throw new Error("callerOf used before authenticate");
  return req.caller;
};

export const orgCallerOf = (req: Request): OrgCaller => {
  const caller = callerOf(req);
  if (!caller.organizationId) {
    throw new Error("orgCallerOf used without requireOrganization");
  }
  return { ...caller, organizationId: caller.organizationId };
};
