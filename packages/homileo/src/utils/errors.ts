import { Response, Request, NextFunction } from "express";
import { InvalidAuditEntryError } from "@tereo-io/sdk";
import { logger } from "./logger.js";
import { ZodError } from "zod";
import {
  isForeignKeyConstraintError,
  isUniqueConstraintError,
} from "./prismaErrors.js";

export interface AppErrorOptions {
  /** Extra response body fields, after `error` and `error_description`. */
  details?: Record<string, unknown>;
  /** Response headers, e.g. `Retry-After`. */
  headers?: Record<string, string | number>;
}

export class AppError extends Error {
  public details?: Record<string, unknown>;
  public headers?: Record<string, string | number>;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    options: AppErrorOptions = {}
  ) {
    super(message);
    this.name = "AppError";
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** One failed check: `path` is the field, dotted (`grants.0.permission`), "" for the whole value. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export const issuesOf = (error: ZodError): ValidationIssue[] =>
  error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

export class ValidationError extends AppError {
  constructor(message: string, issues?: ValidationIssue[]) {
    super(400, "invalid_request", message, {
      details: issues ? { issues } : undefined,
    });
    this.name = "ValidationError";
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    code = "unauthorized",
    options: AppErrorOptions = {}
  ) {
    super(401, code, message, options);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

/** The caller can read the session but takes no part in it. */
export class NotAParticipantError extends AppError {
  constructor(message = "You are not a participant of this session") {
    super(403, "not_a_participant", message);
    this.name = "NotAParticipantError";
  }
}

/** A participant of a space whose post policy is `moderators`, without the right to moderate it. */
export class PostingRestrictedError extends AppError {
  constructor(message = "Only the space's moderators can post here") {
    super(403, "posting_restricted", message);
    this.name = "PostingRestrictedError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

/** A change to something archived. */
export class ArchivedError extends ConflictError {
  constructor(message = "The resource is archived") {
    super(message, "resource_archived");
    this.name = "ArchivedError";
  }
}

/** Archiving something already archived. */
export class AlreadyArchivedError extends ConflictError {
  constructor(message = "The resource is already archived") {
    super(message, "already_archived");
    this.name = "AlreadyArchivedError";
  }
}

export class ManagedByProvisioningError extends AppError {
  constructor(
    message = "Managed by the provisioning file; change it there and restart the service"
  ) {
    super(409, "managed_by_provisioning", message);
    this.name = "ManagedByProvisioningError";
  }
}

/**
 * Every rate-limit refusal: `too_many_requests`, with the seconds to wait in
 * both the `Retry-After` header and the body's `retry_after`.
 */
export class TooManyRequestsError extends AppError {
  constructor(
    public retryAfter: number,
    message = "Rate limit exceeded. Please try again later."
  ) {
    super(429, "too_many_requests", message, {
      details: { retry_after: retryAfter },
      headers: { "Retry-After": retryAfter },
    });
    this.name = "TooManyRequestsError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, retryAfter?: number) {
    super(503, "temporarily_unavailable", message, {
      headers:
        retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    });
    this.name = "ServiceUnavailableError";
  }
}

/**
 * An AppError, or anything shaped like one — a library error carrying an HTTP
 * status. Prisma errors have a string `code` but no `statusCode`, so they fall
 * through to their own branch below.
 */
const isAppErrorLike = (
  err: unknown
): err is Error & { statusCode: number; code: string } => {
  if (err instanceof AppError) return true;
  const { statusCode, code } = (err ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  return (
    Number.isInteger(statusCode) &&
    (statusCode as number) >= 400 &&
    (statusCode as number) <= 599 &&
    typeof code === "string"
  );
};

/**
 * A body-parser (`express.json` / `express.urlencoded`) rejection: an
 * http-errors 4xx with a string `type` such as `entity.parse.failed` or
 * `entity.too.large`, but no `code`.
 */
const bodyParserError = (
  err: unknown
): { status: number; code: string; message: string } | null => {
  const { status, type, expose } = (err ?? {}) as {
    status?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  if (
    typeof type !== "string" ||
    !Number.isInteger(status) ||
    (status as number) < 400 ||
    (status as number) > 499
  ) {
    return null;
  }
  if (type === "entity.parse.failed") {
    return {
      status: 400,
      code: "invalid_request",
      message: "Request body is malformed",
    };
  }
  if (type === "entity.too.large") {
    return {
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large",
    };
  }
  return {
    status: status as number,
    code: "invalid_request",
    message:
      expose === true && err instanceof Error
        ? err.message
        : "Request body could not be read",
  };
};

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  headers?: Record<string, string | number>;
}

const errorResponse = (err: Error): ErrorResponse => {
  const bodyError = bodyParserError(err);
  if (bodyError) return bodyError;

  if (err instanceof ZodError) {
    // RFC 6749 Section 5.2: invalid_request for malformed requests
    return {
      status: 400,
      code: "invalid_request",
      message: err.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", "),
      details: { issues: issuesOf(err) },
    };
  }

  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
      headers: err.headers,
    };
  }

  if (isAppErrorLike(err)) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }

  // An audit entry the SDK refused before queueing it: the caller's input.
  if (err instanceof InvalidAuditEntryError) {
    return { status: 400, code: "invalid_request", message: err.message };
  }

  // A write conflict or deadlock (P2034): retryable, so 409 lets clients
  // back off and retry.
  const prismaCode = (err as { code?: unknown }).code;
  if (prismaCode === "P2034") {
    return {
      status: 409,
      code: "version_conflict",
      message:
        "Concurrent update conflict; retry the request after re-reading state",
    };
  }

  // An update or delete whose row was not there (P2025) that no caller
  // mapped: the row is gone, typically deleted since the request read it.
  if (prismaCode === "P2025") {
    return { status: 404, code: "not_found", message: "Not found" };
  }

  // A unique violation that no caller mapped to a specific error — typically
  // two concurrent creates of the same name. Besides P2002 it arrives wrapped
  // in other codes or as the raw driver adapter error (see prismaErrors.ts).
  if (isUniqueConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message: "A resource with the same unique value already exists",
    };
  }

  // A foreign-key or RESTRICT violation no caller mapped: the row is still
  // referenced, or a row it references went away since the request read it.
  if (isForeignKeyConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message:
        "The change conflicts with a record this one references or is referenced by",
    };
  }

  return {
    status: 500,
    code: "server_error",
    message: "An unexpected error occurred",
  };
};

// Set by a download before its body fails; on the error they would describe
// the JSON body as the file (a 416 passes its own `Content-Range`).
const REPRESENTATION_HEADERS = [
  "Content-Disposition",
  "Content-Range",
  "ETag",
  "Last-Modified",
];

const writeError = (
  res: Response,
  { status, code, message, details, headers }: ErrorResponse
): void => {
  if (res.headersSent) {
    // The status line is out: only a reset tells the client the body is cut.
    res.destroy();
    return;
  }
  for (const name of REPRESENTATION_HEADERS) res.removeHeader(name);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers ?? {})) {
    res.setHeader(name, value);
  }
  res
    .status(status)
    .json({ error: code, error_description: message, ...details });
};

/**
 * Write an error response where an error cannot be thrown to the handler,
 * e.g. from a stream's `error` event once the controller has returned.
 */
export const sendError = (res: Response, err: AppError): void => {
  writeError(res, errorResponse(err));
};

/**
 * A Prisma validation error's message reprints the whole query, argument
 * values included. For logs it is cut to its first line, which names the
 * call, and the stack keeps its frames without the message.
 */
export const loggableError = (err: Error): Error => {
  if (err.name !== "PrismaClientValidationError") return err;
  const summary =
    err.message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const loggable = new Error(summary);
  loggable.name = err.name;
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  loggable.stack = [`${err.name}: ${summary}`, ...frames].join("\n");
  return loggable;
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const response = errorResponse(err);
  const { status, code } = response;

  // The query string is left out.
  const context = {
    method: req.method,
    path: req.originalUrl?.split(/[?#]/, 1)[0],
    status,
  };
  const logged = loggableError(err);
  if (status >= 500) {
    logger.error({ ...context, err: logged }, logged.message);
  } else {
    logger.warn({ ...context, code, name: err.name }, logged.message);
  }

  writeError(res, response);
};
