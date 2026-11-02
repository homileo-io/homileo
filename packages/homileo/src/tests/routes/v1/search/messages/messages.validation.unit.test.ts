// @module-tag unit
// @module-tag search
import { SearchMessagesQuerySchema } from "../../../../../routes/v1/search/messages/schemas.js";
import { describe, expect, it } from "vitest";

const ID = "0190f3a5-7c4e-7000-8000-000000000001";

describe("SearchMessagesQuerySchema", () => {
  it.each([
    [{ q: "screws" }, true],
    [{ q: "  screws  " }, true],
    [{}, false],
    [{ q: "" }, false],
    [{ q: "   " }, false],
    [{ q: "x".repeat(200) }, true],
    [{ q: "x".repeat(201) }, false],
    [{ q: "x", limit: "1" }, true],
    [{ q: "x", limit: "50" }, true],
    [{ q: "x", limit: "0" }, false],
    [{ q: "x", limit: "51" }, false],
    [{ q: "x", sessionId: ID, spaceId: ID, senderId: ID }, true],
    [{ q: "x", sessionId: "nope" }, false],
    [{ q: "x", kind: "support:case" }, true],
    [{ q: "x", from: "2026-11-02T00:00:00.000Z" }, true],
    [{ q: "x", to: "2026-11-02T01:00:00+01:00" }, true],
    [{ q: "x", from: "yesterday" }, false],
    [{ q: "x", hasAttachment: "true", inThread: "false" }, true],
    [{ q: "x", hasAttachment: "yes" }, false],
    [{ q: "x", "metadata[orderNumber]": "ORD-1234" }, true],
    [{ q: "x", "metadata[1bad]": "v" }, false],
    [{ q: "x", "metadata[orderNumber]": "" }, false],
    [{ q: "x", "metadata[orderNumber]": ["a", "b"] }, false],
    [
      {
        q: "x",
        ...Object.fromEntries(
          [1, 2, 3, 4, 5, 6].map((i) => [`metadata[k${i}]`, "v"])
        ),
      },
      false,
    ],
    [{ q: "x", metadata: "v" }, false],
    [{ q: "x", cursor: "abc" }, true],
    [{ q: "x", unknown: "1" }, false],
  ])("%j is valid: %s", (query, valid) => {
    expect(SearchMessagesQuerySchema.safeParse(query).success).toBe(valid);
  });

  it("trims q, defaults limit and lifts the metadata filters", () => {
    expect(
      SearchMessagesQuerySchema.parse({
        q: "  screws ",
        "metadata[orderNumber]": "ORD-1",
      })
    ).toEqual({ q: "screws", limit: 20, metadata: { orderNumber: "ORD-1" } });
  });
});
