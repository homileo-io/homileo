// @module-tag unit
// @module-tag platform
import { InvalidAuditEntryError, RequestError, HttpError } from "@tereo-io/sdk";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  errorHandler,
  issuesOf,
  MAX_ISSUE_CHARS,
  MAX_ISSUES,
} from "../../utils/errors.js";

const fakeRes = () => {
  const res = {
    headersSent: false,
    removeHeader: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

const handle = (err: Error) => {
  const res = fakeRes();
  errorHandler(
    err,
    { method: "POST", originalUrl: "/x" } as Request,
    res as unknown as Response,
    vi.fn() as NextFunction
  );
  return res;
};

const prismaError = (code: string, meta: Record<string, unknown> = {}) =>
  Object.assign(new Error("prisma"), {
    name: "PrismaClientKnownRequestError",
    code,
    meta,
  });

// The shapes below are what pg 8 and Prisma 7's pg adapter raise, captured
// against a listener that never answers and one that refuses the startup
// with the SQLSTATE.
const adapterWrapped = (
  code: string,
  cause: Record<string, unknown>,
  message: string
) =>
  Object.assign(new Error(message), {
    name: "PrismaClientKnownRequestError",
    code,
    meta: {
      driverAdapterError: Object.assign(new Error(String(cause.kind)), {
        name: "DriverAdapterError",
        cause,
      }),
    },
  });

const connectTimeout = () =>
  new Error("Connection terminated due to connection timeout", {
    cause: new Error("Connection terminated unexpectedly"),
  });

const tooManyConnections = (prismaCode: "P2010" | "P2037") =>
  adapterWrapped(
    prismaCode,
    { originalCode: "53300", kind: "TooManyConnections" },
    "Too many database connections opened: sorry, too many clients already"
  );

const cannotConnectNow = (prismaCode: "P2010" | "P2039") =>
  adapterWrapped(
    prismaCode,
    { code: "57P03", originalCode: "57P03", kind: "postgres" },
    "Database error. Code: `57P03`. Message: `the database system is starting up`"
  );

describe("errorHandler: a busy database is 503", () => {
  const lockTimeout = {
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: { kind: "postgres", code: "55P03", originalCode: "55P03" },
    },
  };

  it.each([
    ["a transaction that could not start (P2028)", prismaError("P2028")],
    [
      "an expired transaction (P2028)",
      prismaError("P2028", { operation: "query", timeout: 1000 }),
    ],
    ["a lock timeout in raw SQL (P2010)", prismaError("P2010", lockTimeout)],
    [
      "a lock timeout in a model query (P2039)",
      prismaError("P2039", lockTimeout),
    ],
    [
      "no pool connection in time",
      new Error("timeout exceeded when trying to connect"),
    ],
    [
      "no pool connection in time, wrapped",
      new Error("query failed", {
        cause: new Error("timeout exceeded when trying to connect"),
      }),
    ],
    ["a new connection that timed out opening", connectTimeout()],
    [
      "a new connection that timed out opening, wrapped",
      new Error("query failed", { cause: connectTimeout() }),
    ],
    [
      "a new connection that timed out opening, under an adapter error",
      prismaError("P2010", { driverAdapterError: { cause: connectTimeout() } }),
    ],
    [
      "too many connections in a model query (P2037)",
      tooManyConnections("P2037"),
    ],
    ["too many connections in raw SQL (P2010)", tooManyConnections("P2010")],
    [
      "too many connections from pg itself",
      Object.assign(new Error("sorry, too many clients already"), {
        code: "53300",
      }),
    ],
    ["a database starting up, in a model query", cannotConnectNow("P2039")],
    ["a database starting up, in raw SQL", cannotConnectNow("P2010")],
  ])("maps %s to temporarily_unavailable with Retry-After", (_name, err) => {
    const res = handle(err);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", 1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "temporarily_unavailable" })
    );
  });

  it("leaves another raw-query failure a 500", () => {
    const res = handle(
      prismaError("P2010", {
        driverAdapterError: { cause: { code: "42P01", originalCode: "42P01" } },
      })
    );

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("leaves a dropped connection a 500", () => {
    const res = handle(new Error("Connection terminated unexpectedly"));

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("errorHandler: a deadlock or serialization failure is 409", () => {
  it.each([
    ["a write conflict (P2034)", prismaError("P2034")],
    [
      "a deadlock in raw SQL (P2010)",
      adapterWrapped(
        "P2010",
        { code: "40P01", originalCode: "40P01", kind: "postgres" },
        "Raw query failed. Code: `40P01`. Message: `deadlock detected`"
      ),
    ],
    [
      "a serialization failure in a model query (P2039)",
      adapterWrapped(
        "P2039",
        { code: "40001", originalCode: "40001", kind: "postgres" },
        "Database error. Code: `40001`."
      ),
    ],
    [
      "a deadlock from pg itself",
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    ],
  ])("maps %s to version_conflict", (_name, err) => {
    const res = handle(err);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "version_conflict" })
    );
  });
});

describe("errorHandler: library errors", () => {
  const body = (res: ReturnType<typeof fakeRes>) =>
    JSON.stringify(res.json.mock.calls[0][0]);

  it.each([
    [
      "a tereo RequestError",
      new RequestError("AS_0003", "Failed to fetch the user from core"),
    ],
    [
      "a tereo RequestError with a 4xx statusCode",
      new RequestError("FS_0013", "Object lookup failed", { statusCode: 404 }),
    ],
    [
      "an error-like object with a 5xx status",
      Object.assign(new Error("upstream said no"), {
        statusCode: 502,
        code: "bad_gateway",
      }),
    ],
    [
      "an error-like object whose code is not documented",
      Object.assign(new Error("internal detail"), {
        statusCode: 400,
        code: "LIB_0042",
      }),
    ],
    [
      "a documented code under another status",
      new HttpError(400, "unauthorized", "internal detail"),
    ],
    [
      "an error shaped like the auth middleware's but not an HttpError",
      Object.assign(new Error("internal detail"), {
        name: "HttpError",
        statusCode: 401,
        code: "unauthorized",
      }),
    ],
  ])("answers %s with 500 server_error and nothing of its own", (_n, err) => {
    const res = handle(err);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "server_error" })
    );
    expect(body(res)).not.toContain((err as { code: string }).code);
    expect(body(res)).not.toContain(err.message);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
  ])(
    "passes the auth middleware's %i %s HttpError through",
    (statusCode, code) => {
      const res = handle(
        new HttpError(statusCode, code, "Invalid or expired token")
      );

      expect(res.status).toHaveBeenCalledWith(statusCode);
      expect(res.json).toHaveBeenCalledWith({
        error: code,
        error_description: "Invalid or expired token",
      });
    }
  );
});

describe("errorHandler: body-parser rejections", () => {
  const bodyParserError = (status: number, type: string, message: string) =>
    Object.assign(new Error(message), { status, type, expose: true });

  it.each([
    [415, "charset.unsupported", 'unsupported charset "LATIN-9"'],
    [415, "encoding.unsupported", 'unsupported content encoding "br"'],
    [400, "request.aborted", "request aborted"],
    [403, "entity.verify.failed", "entity verification failed"],
  ])("answers a %i %s as 400 invalid_request", (status, type, message) => {
    const res = handle(bodyParserError(status, type, message));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "invalid_request",
      error_description: message,
    });
  });

  it("answers a body over the limit as 413 payload_too_large", () => {
    const res = handle(
      bodyParserError(413, "entity.too.large", "request entity too large")
    );

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "payload_too_large" })
    );
  });
});

describe("errorHandler", () => {
  it("maps InvalidAuditEntryError to 400 invalid_request", () => {
    const res = handle(new InvalidAuditEntryError("action is required"));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "invalid_request",
        error_description: "action is required",
      })
    );
  });
});

describe("issuesOf", () => {
  it("lists at most MAX_ISSUES issues, each path and message cut to MAX_ISSUE_CHARS", () => {
    const key = "k".repeat(MAX_ISSUE_CHARS * 2);
    const keys = Array.from({ length: MAX_ISSUES + 5 }, (_, i) => `${key}${i}`);
    const schema = z.object(
      Object.fromEntries(
        keys.map((k) => [k, z.string().min(1, "m".repeat(MAX_ISSUE_CHARS * 2))])
      )
    );
    const result = schema.safeParse(
      Object.fromEntries(keys.map((k) => [k, ""]))
    );

    const issues = issuesOf(result.error!);

    expect(issues).toHaveLength(MAX_ISSUES);
    for (const issue of issues) {
      expect(issue.path).toHaveLength(MAX_ISSUE_CHARS);
      expect(issue.path.endsWith("…")).toBe(true);
      expect(issue.message).toHaveLength(MAX_ISSUE_CHARS);
    }
  });

  it("keeps short issues as they are", () => {
    const result = z.object({ a: z.string() }).safeParse({ a: 1 });

    expect(issuesOf(result.error!)).toEqual([
      { path: "a", message: result.error!.issues[0]!.message },
    ]);
  });
});
