// @module-tag unit
// @module-tag platform
import { metadataSchema } from "../../utils/metadata.js";
import { describe, expect, it } from "vitest";

const keys = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));

describe("metadataSchema", () => {
  it.each([
    ["an empty object", {}],
    ["50 keys", keys(50)],
    ["a nested object value", { ticket: { id: 7, tags: ["a", "b"] } }],
    ["a key of 64 characters", { ["a" + "b".repeat(63)]: 1 }],
    ["dots, dashes and underscores in a key", { "a.b-c_d": true }],
  ])("accepts %s", (_name, value) => {
    expect(metadataSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["51 keys", keys(51)],
    ["a key starting with a digit", { "1abc": 1 }],
    ["a key of 65 characters", { ["a" + "b".repeat(64)]: 1 }],
    ["a key with a space", { "a b": 1 }],
    ["17 KiB serialized", { big: "x".repeat(17 * 1024) }],
    ["an array", [1]],
    ["null", null],
    ["a string", "x"],
  ])("rejects %s", (_name, value) => {
    expect(metadataSchema.safeParse(value).success).toBe(false);
  });

  it("accepts exactly 16 KiB serialized", () => {
    const overhead = JSON.stringify({ big: "" }).length;
    const value = { big: "x".repeat(16 * 1024 - overhead) };

    expect(JSON.stringify(value)).toHaveLength(16 * 1024);
    expect(metadataSchema.safeParse(value).success).toBe(true);
  });
});
