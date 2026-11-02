// @module-tag unit
// @module-tag search
import { Prisma } from "../../../prisma/generated/client/index.js";
import { describe, expect, it } from "vitest";
import {
  encodeSearchCursor,
  liftMetadataQuery,
  metadataFilterSql,
  parseHeadline,
  parseSearchCursor,
  parseSearchQuery,
  SearchMetadataQuerySchema,
} from "../../utils/search.js";

const START = "";
const STOP = "";

describe("parseSearchQuery", () => {
  it("keeps a plain term for the trigram arm", () => {
    expect(parseSearchQuery("ORD-1234")).toEqual({
      text: "ORD-1234",
      trigramTerm: "ORD-1234",
    });
  });

  it("trims the query", () => {
    expect(parseSearchQuery("  screws ")).toEqual({
      text: "screws",
      trigramTerm: "screws",
    });
  });

  it.each([
    ['"missing screws"', "a phrase"],
    ["refund -shipping", "an exclusion"],
    ["-shipping", "a leading exclusion"],
    ["refund OR return", "an OR"],
    ["refund or return", "a lowercase or"],
    ["ab", "under 3 characters"],
    ["  ab  ", "under 3 characters once trimmed"],
  ])("leaves out the trigram arm for %j (%s)", (q) => {
    expect(parseSearchQuery(q).trigramTerm).toBeNull();
  });

  it("keeps a hyphen inside a word", () => {
    expect(parseSearchQuery("e-mail").trigramTerm).toBe("e-mail");
  });
});

describe("parseHeadline", () => {
  it("turns markers into a range", () => {
    expect(parseHeadline(`a ${START}screw${STOP} here`)).toEqual({
      text: "a screw here",
      highlights: [[2, 7]],
    });
  });

  it("counts UTF-16 code units past a character outside the BMP", () => {
    expect(parseHeadline(`😀 ${START}box${STOP}`)).toEqual({
      text: "😀 box",
      highlights: [[3, 6]],
    });
  });

  it("returns no ranges without markers", () => {
    expect(parseHeadline("no match")).toEqual({
      text: "no match",
      highlights: [],
    });
  });

  it("finds several ranges", () => {
    expect(parseHeadline(`${START}a${STOP} b ${START}c${STOP}`)).toEqual({
      text: "a b c",
      highlights: [
        [0, 1],
        [4, 5],
      ],
    });
  });

  it.each([
    [`a ${STOP}b`, "a stop without a start"],
    [`a ${START}b`, "a start without a stop"],
  ])("drops %j (%s) and makes no range", (marked) => {
    expect(parseHeadline(marked)).toEqual({ text: "a b", highlights: [] });
  });

  it("keeps the later start of two in a row", () => {
    expect(parseHeadline(`${START}a ${START}b${STOP}`)).toEqual({
      text: "a b",
      highlights: [[2, 3]],
    });
  });
});

describe("search cursors", () => {
  it("round-trip asOf and offset", () => {
    const asOf = new Date("2026-11-02T00:00:00.000Z");
    expect(parseSearchCursor(encodeSearchCursor(asOf, 40), 1000)).toEqual({
      asOf,
      offset: 40,
    });
  });

  it.each([
    ["at the depth", () => encodeSearchCursor(new Date(), 1000)],
    ["negative", () => encodeSearchCursor(new Date(), -1)],
    ["fractional", () => encodeSearchCursor(new Date(), 1.5)],
    [
      "with a non-date asOf",
      () =>
        Buffer.from(JSON.stringify(["yesterday", 20])).toString("base64url"),
    ],
    ["not base64url", () => "%%%"],
  ])("refuse an offset or cursor %s", (_name, cursor) => {
    expect(() => parseSearchCursor(cursor(), 1000)).toThrow("Invalid cursor");
  });
});

describe("liftMetadataQuery", () => {
  it("moves metadata[<key>] query keys under metadata", () => {
    expect(
      liftMetadataQuery({ q: "x", "metadata[orderNumber]": "ORD-1" })
    ).toEqual({ q: "x", metadata: { orderNumber: "ORD-1" } });
  });

  it("leaves a query without them as it is", () => {
    expect(liftMetadataQuery({ q: "x" })).toEqual({ q: "x" });
  });
});

describe("liftMetadataQuery with __proto__", () => {
  it("keeps the key, for the schema to refuse", () => {
    const lifted = liftMetadataQuery({ "metadata[__proto__]": "x" });
    expect(
      SearchMetadataQuerySchema.safeParse(
        (lifted as { metadata: unknown }).metadata
      ).success
    ).toBe(false);
  });
});

describe("SearchMetadataQuerySchema", () => {
  it.each([
    [{ orderNumber: "ORD-1" }, true],
    [{ "a.b_c-d": "1" }, true],
    [{ "1bad": "x" }, false],
    [{ orderNumber: "" }, false],
    [{ orderNumber: "x".repeat(256) }, false],
    [{ orderNumber: ["a", "b"] }, false],
    [Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`k${i}`, "v"])), true],
    [Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`k${i}`, "v"])), false],
  ])("%j is valid: %s", (metadata, valid) => {
    expect(SearchMetadataQuerySchema.safeParse(metadata).success).toBe(valid);
  });
});

describe("metadataFilterSql", () => {
  const forms = (value: string) =>
    metadataFilterSql(Prisma.raw("m"), "k", value).sql.match(/@>/g)?.length;

  it.each([
    ["ORD-1", 1],
    ["1234", 2],
    ["-1.5", 2],
    ["0", 2],
    ["true", 2],
    ["01234", 1],
    ["1.50", 1],
    ["1.", 1],
  ])("%j is matched in %i form(s)", (value, count) => {
    expect(forms(value)).toBe(count);
  });
});
