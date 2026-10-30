// @module-tag unit
// @module-tag spaces
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  MemberParamsSchema,
  PutMemberSchema,
} from "../../../../../../../routes/v1/spaces/space/members/member/schemas.js";

describe("PutMemberSchema", () => {
  it.each(["owner", "moderator", "member"])("accepts the role %s", (role) => {
    expect(PutMemberSchema.parse({ role })).toEqual({ role });
  });

  it.each([
    ["no role", {}],
    ["an unknown role", { role: "boss" }],
    ["an unknown field", { role: "member", extra: 1 }],
  ])("rejects %s", (_label, body) => {
    expect(PutMemberSchema.safeParse(body).success).toBe(false);
  });
});

describe("MemberParamsSchema", () => {
  it("lower-cases both ids", () => {
    const spaceId = uuidv7();
    const principalId = uuidv7();
    expect(
      MemberParamsSchema.parse({
        spaceId: spaceId.toUpperCase(),
        principalId: principalId.toUpperCase(),
      })
    ).toEqual({ spaceId, principalId });
  });

  it("takes two UUIDs and refuses anything else", () => {
    expect(
      MemberParamsSchema.safeParse({ spaceId: uuidv7(), principalId: uuidv7() })
        .success
    ).toBe(true);
    expect(
      MemberParamsSchema.safeParse({ spaceId: uuidv7(), principalId: "x" })
        .success
    ).toBe(false);
  });
});
