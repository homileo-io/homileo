// @module-tag unit
// @module-tag platform
import type { NextFunction, Request, Response } from "express";
import { InvalidAuditEntryError } from "@tereo-io/sdk";
import { errorHandler } from "../../utils/errors.js";
import { describe, expect, it, vi } from "vitest";

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
});

describe("errorHandler", () => {
  it("maps InvalidAuditEntryError to 400 invalid_request", () => {
    const res = fakeRes();

    errorHandler(
      new InvalidAuditEntryError("action is required"),
      { method: "POST", originalUrl: "/x" } as Request,
      res as unknown as Response,
      vi.fn() as NextFunction
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "invalid_request",
        error_description: "action is required",
      })
    );
  });
});
