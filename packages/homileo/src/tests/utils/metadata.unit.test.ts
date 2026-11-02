// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  boundedJson,
  JSON_MAX_DEPTH,
  metadataSchema,
} from "../../utils/metadata.js";

/** `levels` objects, each the only value of the one outside it. */
const nested = (levels: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
};

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
    [
      "a value nested past JSON_MAX_DEPTH",
      { deep: nested(JSON_MAX_DEPTH + 1) },
    ],
    ["a value nested 5,000 levels deep", { deep: nested(5000) }],
  ])("rejects %s", (_name, value) => {
    expect(metadataSchema.safeParse(value).success).toBe(false);
  });

  it("answers thousands of bad keys with one issue", () => {
    const bad = Object.fromEntries(
      Array.from({ length: 25_000 }, (_, i) => [`${i}bad`, i])
    );
    const result = metadataSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error!.issues).toHaveLength(1);
    expect(result.error!.issues[0]!.message).toBe("At most 50 keys");
  });

  it("accepts a value nested JSON_MAX_DEPTH levels deep", () => {
    expect(
      metadataSchema.safeParse({ deep: nested(JSON_MAX_DEPTH) }).success
    ).toBe(true);
  });
});

describe("boundedJson", () => {
  it.each([
    ["arrays", (n: number) => JSON.parse("[".repeat(n) + "]".repeat(n))],
    ["objects", nested],
  ])("takes %s JSON_MAX_DEPTH deep and refuses one more", (_name, make) => {
    expect(boundedJson().safeParse(make(JSON_MAX_DEPTH)).success).toBe(true);
    expect(boundedJson().safeParse(make(JSON_MAX_DEPTH + 1)).success).toBe(
      false
    );
  });

  it("refuses a value that is not JSON", () => {
    expect(boundedJson().safeParse({ a: () => 1 }).success).toBe(false);
  });

  it("accepts exactly 16 KiB serialized", () => {
    const overhead = JSON.stringify({ big: "" }).length;
    const value = { big: "x".repeat(16 * 1024 - overhead) };

    expect(JSON.stringify(value)).toHaveLength(16 * 1024);
    expect(metadataSchema.safeParse(value).success).toBe(true);
  });
});
