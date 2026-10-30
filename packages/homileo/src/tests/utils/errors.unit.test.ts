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
