import { ValidationError } from "./errors.js";

/** An opaque list cursor: the sort key's values, as base64url JSON. */
export const encodeCursor = (values: (string | number)[]): string =>
  Buffer.from(JSON.stringify(values)).toString("base64url");

export const decodeCursor = (
  cursor: string,
  arity: number
): (string | number)[] => {
  const invalid = () => new ValidationError("Invalid cursor");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(values) ||
    values.length !== arity ||
    !values.every((v) => typeof v === "string" || typeof v === "number")
  ) {
    throw invalid();
  }
  return values as (string | number)[];
};
