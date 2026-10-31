// @module-tag unit
// @module-tag auth
import { ResolveBodySchema } from "../../../../../routes/v1/principals/resolve/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const ID = uuidv7();

describe("POST /v1/principals/resolve body", () => {
  it.each([
    ["an empty list", { tereoUserIds: [] }],
    ["101 ids", { tereoUserIds: Array.from({ length: 101 }, () => uuidv7()) }],
    ["a non-UUID", { tereoUserIds: ["not-a-uuid"] }],
    ["duplicates", { tereoUserIds: [ID, ID] }],
    [
      "duplicates that differ in case",
      { tereoUserIds: [ID, ID.toUpperCase()] },
    ],
    ["a missing list", {}],
    ["an unknown key", { tereoUserIds: [ID], extra: 1 }],
  ])("rejects %s", (_name, body) => {
    expect(ResolveBodySchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["one id", [uuidv7()]],
    ["100 ids", Array.from({ length: 100 }, () => uuidv7())],
  ])("accepts %s", (_name, tereoUserIds) => {
    expect(ResolveBodySchema.safeParse({ tereoUserIds }).success).toBe(true);
  });

  it("lower-cases ids", () => {
    expect(
      ResolveBodySchema.parse({ tereoUserIds: [ID.toUpperCase()] }).tereoUserIds
    ).toEqual([ID]);
  });
});
