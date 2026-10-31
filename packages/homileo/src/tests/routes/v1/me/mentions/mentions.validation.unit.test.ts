// @module-tag unit
// @module-tag auth
// @module-tag sessions
// @module-tag messages
import { ListMentionsQuerySchema } from "../../../../../routes/v1/me/mentions/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

describe("GET /v1/me/mentions query", () => {
  it("defaults the limit to 50", () => {
    expect(ListMentionsQuerySchema.parse({}).limit).toBe(50);
  });

  it.each([
    ["limit 0", { limit: "0" }],
    ["limit 101", { limit: "101" }],
    ["a fractional limit", { limit: "1.5" }],
    ["an empty cursor", { cursor: "" }],
    ["an unknown key", { extra: "1" }],
  ])("rejects %s", (_name, input) => {
    expect(ListMentionsQuerySchema.safeParse(input).success).toBe(false);
  });

  it("accepts a cursor and limit 100", () => {
    expect(
      ListMentionsQuerySchema.safeParse({ cursor: uuidv7(), limit: "100" })
        .success
    ).toBe(true);
  });
});
