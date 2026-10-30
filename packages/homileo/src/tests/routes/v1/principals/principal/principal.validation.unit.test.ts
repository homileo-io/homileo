// @module-tag unit
// @module-tag auth
import { PrincipalParamsSchema } from "../../../../../routes/v1/principals/principal/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

describe("PrincipalParamsSchema", () => {
  it("lower-cases the id", () => {
    const id = uuidv7();

    expect(
      PrincipalParamsSchema.parse({ principalId: id.toUpperCase() }).principalId
    ).toBe(id);
  });

  it.each(["", "abc", "123"])("rejects %j", (principalId) => {
    expect(PrincipalParamsSchema.safeParse({ principalId }).success).toBe(
      false
    );
  });
});
