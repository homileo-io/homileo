// @module-tag unit
// @module-tag search
import { searchTextOf } from "../../utils/searchText.js";
import { describe, expect, it } from "vitest";

describe("searchTextOf", () => {
  it("puts the name first, then each declared key in declared order", () => {
    expect(
      searchTextOf("Case 9", { customerName: "Ada Lovelace", internal: "x" }, [
        "customerName",
      ])
    ).toBe("Case 9 Ada Lovelace");
  });

  it("takes numbers and booleans through String", () => {
    expect(
      searchTextOf(null, { orderNumber: 1234, vip: true }, [
        "orderNumber",
        "vip",
      ])
    ).toBe("1234 true");
  });

  it("visits scalar leaves depth-first and skips null and missing keys", () => {
    expect(
      searchTextOf("n", { tags: ["a", { b: "c" }], none: null }, [
        "tags",
        "none",
        "missing",
      ])
    ).toBe("n a c");
  });

  it("is empty with no name and no keys", () => {
    expect(searchTextOf(null, {}, [])).toBe("");
  });
});
