// @module-tag unit
// @module-tag spaces
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  ListMembersQuerySchema,
  MemberCursorSchema,
} from "../../../../../../routes/v1/spaces/space/members/schemas.js";

describe("ListMembersQuerySchema", () => {
  it("defaults the limit to 50", () => {
    expect(ListMembersQuerySchema.parse({}).limit).toBe(50);
  });

  it.each([
    ["an unknown role", { role: "boss" }],
    ["a limit of 0", { limit: "0" }],
    ["a limit over 100", { limit: "101" }],
    ["an unknown parameter", { status: "x" }],
  ])("rejects %s", (_label, query) => {
    expect(ListMembersQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("MemberCursorSchema", () => {
  it("accepts a timestamp and an id", () => {
    expect(
      MemberCursorSchema.safeParse([new Date().toISOString(), uuidv7()]).success
    ).toBe(true);
  });

  it("lower-cases the id", () => {
    const at = new Date().toISOString();
    const id = uuidv7();
    expect(MemberCursorSchema.parse([at, id.toUpperCase()])).toEqual([at, id]);
  });

  it.each([
    ["a non-timestamp", ["yesterday", uuidv7()]],
    ["a non-uuid id", [new Date().toISOString(), "x"]],
    ["numbers", [1, 2]],
  ])("rejects %s", (_label, key) => {
    expect(MemberCursorSchema.safeParse(key).success).toBe(false);
  });
});
