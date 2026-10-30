// @module-tag unit
// @module-tag spaces
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  SpaceParamsSchema,
  UpdateSpaceSchema,
} from "../../../../../routes/v1/spaces/space/schemas.js";

describe("SpaceParamsSchema", () => {
  it("accepts a UUID", () => {
    expect(SpaceParamsSchema.safeParse({ spaceId: uuidv7() }).success).toBe(
      true
    );
  });

  it.each(["", "abc", "123", `${uuidv7()}x`])("rejects %j", (spaceId) => {
    expect(SpaceParamsSchema.safeParse({ spaceId }).success).toBe(false);
  });
});

describe("UpdateSpaceSchema", () => {
  it("accepts any one field", () => {
    for (const body of [
      { name: "a" },
      { description: null },
      { visibility: "public" },
      { joinPolicy: "open" },
      { postPolicy: "moderators" },
      { state: null },
      { externalRef: null },
      { metadata: {} },
    ]) {
      expect(UpdateSpaceSchema.safeParse(body).success).toBe(true);
    }
  });

  it("trims the name", () => {
    expect(UpdateSpaceSchema.parse({ name: " a " })).toEqual({ name: "a" });
  });

  it.each([
    ["an empty body", {}],
    ["an unknown field", { kind: "other" }],
    ["a blank name", { name: " " }],
    ["a name over 255 characters", { name: "x".repeat(256) }],
    ["an externalRef over 255 characters", { externalRef: "x".repeat(256) }],
    ["a bad metadata key", { metadata: { "a b": 1 } }],
    ["metadata over 16 KiB", { metadata: { big: "x".repeat(17 * 1024) } }],
    ["an unknown joinPolicy", { joinPolicy: "closed" }],
  ])("rejects %s", (_label, body) => {
    expect(UpdateSpaceSchema.safeParse(body).success).toBe(false);
  });
});
