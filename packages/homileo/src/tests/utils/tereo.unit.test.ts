// @module-tag unit
// @module-tag platform
import { getTereo } from "../../utils/tereo.js";
import { describe, expect, it } from "vitest";

describe("tereo client", () => {
  it("refuses getTereo() before initializeTereo()", () => {
    expect(() => getTereo()).toThrow(/initializeTereo/);
  });
});
