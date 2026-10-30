// @module-tag unit
// @module-tag auth
import { principalRow } from "../support/pure/viewRows.js";
import { principalView } from "../../views/index.js";
import { PrincipalSchema } from "@homileo-io/sdk";
import { describe, expect, it } from "vitest";

describe("principalView", () => {
  it("output parses with its SDK schema", () => {
    const view = principalView(principalRow);
    expect(PrincipalSchema.safeParse(view).success).toBe(true);
    expect(view).not.toHaveProperty("externalId");
  });
});
