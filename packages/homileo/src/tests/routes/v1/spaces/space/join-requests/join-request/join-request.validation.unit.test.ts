// @module-tag unit
// @module-tag spaces
import { JoinRequestParamsSchema } from "../../../../../../../routes/v1/spaces/space/join-requests/join-request/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

describe("JoinRequestParamsSchema", () => {
  it("lower-cases both ids", () => {
    const spaceId = uuidv7();
    const principalId = uuidv7();
    expect(
      JoinRequestParamsSchema.parse({
        spaceId: spaceId.toUpperCase(),
        principalId: principalId.toUpperCase(),
      })
    ).toEqual({ spaceId, principalId });
  });

  it("refuses a non-UUID", () => {
    expect(
      JoinRequestParamsSchema.safeParse({ spaceId: uuidv7(), principalId: "x" })
        .success
    ).toBe(false);
  });
});
