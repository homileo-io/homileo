import { ValidationError, type ValidationIssue } from "./errors.js";
import { ZodSchema, z, type ZodError } from "zod";
import type { Request } from "express";

/** The most issues a 400 lists; `error_description` says how many it left out. */
export const MAX_ISSUES = 20;
/** The most characters of an issue's path or message: a path holds the request's own keys. */
export const MAX_ISSUE_CHARS = 256;

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const invalid = (what: string, error: ZodError): ValidationError => {
  const issues: ValidationIssue[] = error.issues
    .slice(0, MAX_ISSUES)
    .map((i) => ({
      path: truncate(i.path.join("."), MAX_ISSUE_CHARS),
      message: truncate(i.message, MAX_ISSUE_CHARS),
    }));
  const more = error.issues.length - issues.length;
  const listed = issues.map((i) => `${i.path}: ${i.message}`).join(", ");
  return new ValidationError(
    `Invalid request ${what}. ${listed}${more > 0 ? `, and ${more} more` : ""}`,
    issues
  );
};

export const validateParams = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.params);
  if (!result.success) throw invalid("params", result.error);
  return result.data;
};

export const validateQuery = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.query);
  if (!result.success) throw invalid("query", result.error);
  return result.data;
};

export const validateBody = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.body);
  if (!result.success) throw invalid("body", result.error);
  return result.data;
};

/** Header names arrive lowercased: key the schema by `"x-metadata"`, not `"X-Metadata"`. */
export const validateHeaders = <T extends ZodSchema>(
  schema: T,
  req: Request
): z.infer<T> => {
  const result = schema.safeParse(req.headers);
  if (!result.success) throw invalid("headers", result.error);
  return result.data;
};
