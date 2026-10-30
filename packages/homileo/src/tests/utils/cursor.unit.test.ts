// @module-tag unit
// @module-tag platform
import { decodeCursor, encodeCursor } from "../../utils/cursor.js";
import { ValidationError } from "../../utils/errors.js";
import { describe, expect, it } from "vitest";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("cursor", () => {
  it("round trips strings and numbers", () => {
    const values = ["2026-10-30T10:00:00.000Z", "0192f4aa", 42];

    expect(decodeCursor(encodeCursor(values), 3)).toEqual(values);
  });

  it("is url-safe", () => {
    expect(encodeCursor(["a?b/c+d>>>"])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["a wrong arity", encodeCursor(["a", "b"]), 3],
    ["bad base64", "!!!not base64!!!", 1],
    ["an empty cursor", "", 1],
    ["a non-array", b64({ a: 1 }), 1],
    ["a non-JSON payload", Buffer.from("nope").toString("base64url"), 1],
    ["a nested value", b64([["a"]]), 1],
    ["a null value", b64([null]), 1],
  ])("rejects %s", (_name, cursor, arity) => {
    expect(() => decodeCursor(cursor, arity)).toThrow(ValidationError);
  });
});
