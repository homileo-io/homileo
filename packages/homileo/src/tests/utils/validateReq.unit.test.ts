// @module-tag unit
// @module-tag platform
import type { ValidationError } from "../../utils/errors.js";
import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { z } from "zod";
import {
  MAX_ISSUE_CHARS,
  MAX_ISSUES,
  validateBody,
  validateParams,
  validateQuery,
} from "../../utils/validateReq.js";

const failure = (run: () => unknown): ValidationError => {
  try {
    run();
  } catch (err) {
    return err as ValidationError;
  }
  throw new Error("expected a ValidationError");
};

const many = z.record(z.string(), z.number());
const manyBad = Object.fromEntries(
  Array.from({ length: 5000 }, (_, i) => [`${i}${"k".repeat(1000)}`, "x"])
);

describe("validateBody, validateParams and validateQuery", () => {
  it.each([
    ["body", () => validateBody(many, { body: manyBad } as Request)],
    ["params", () => validateParams(many, { params: manyBad } as Request)],
    [
      "query",
      () => validateQuery(many, { query: manyBad } as unknown as Request),
    ],
  ])("cap the %s issues and the length of each", (_where, run) => {
    const err = failure(run);
    const issues = err.details!.issues as Array<{
      path: string;
      message: string;
    }>;

    expect(err.statusCode).toBe(400);
    expect(issues).toHaveLength(MAX_ISSUES);
    for (const issue of issues) {
      expect(issue.path.length).toBeLessThanOrEqual(MAX_ISSUE_CHARS);
      expect(issue.message.length).toBeLessThanOrEqual(MAX_ISSUE_CHARS);
    }
    expect(err.message.length).toBeLessThan(
      MAX_ISSUES * 2 * (MAX_ISSUE_CHARS + 4) + 100
    );
    expect(err.message).toMatch(/, and 4980 more$/);
  });

  it("lists every issue when there are few", () => {
    const err = failure(() =>
      validateBody(z.object({ a: z.number() }), { body: {} } as Request)
    );
    expect(err.details!.issues).toHaveLength(1);
    expect(err.message).toBe(
      "Invalid request body. a: Invalid input: expected number, received undefined"
    );
  });
});
