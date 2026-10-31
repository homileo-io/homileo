// @module-tag unit
// @module-tag spaces
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  CreateSpaceSchema,
  ListSpacesQuerySchema,
  SpaceCursorSchema,
} from "../../../../routes/v1/spaces/schemas.js";

describe("CreateSpaceSchema", () => {
  it("accepts a name alone and trims it", () => {
    const parsed = CreateSpaceSchema.parse({ name: "  Hello " });

    expect(parsed).toEqual({ name: "Hello" });
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["a name over 255 characters", { name: "x".repeat(256) }],
    ["no name", {}],
    [
      "an externalRef over 255 characters",
      { name: "a", externalRef: "x".repeat(256) },
    ],
    ["an empty externalRef", { name: "a", externalRef: "" }],
    ["an unknown visibility", { name: "a", visibility: "secret" }],
    ["an unknown field", { name: "a", archivedAt: null }],
    ["a state over 64 characters", { name: "a", state: "s".repeat(65) }],
    [
      "a metadata key that is not an identifier",
      { name: "a", metadata: { "1x": 1 } },
    ],
    [
      "metadata of more than 50 keys",
      {
        name: "a",
        metadata: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`k${i}`, 1])
        ),
      },
    ],
    [
      "metadata over 16 KiB",
      { name: "a", metadata: { big: "x".repeat(17 * 1024) } },
    ],
  ])("rejects %s", (_label, body) => {
    expect(CreateSpaceSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["a name of 255 characters", { name: "x".repeat(255) }],
    [
      "null description, state and externalRef",
      { name: "a", description: null, state: null, externalRef: null },
    ],
    [
      "metadata of 50 keys",
      {
        name: "a",
        metadata: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`k${i}`, 1])
        ),
      },
    ],
  ])("accepts %s", (_label, body) => {
    expect(CreateSpaceSchema.safeParse(body).success).toBe(true);
  });
});

describe("ListSpacesQuerySchema", () => {
  it("defaults to member spaces, live ones, 50 per page", () => {
    expect(ListSpacesQuerySchema.parse({})).toEqual({
      membership: "member",
      includeArchived: false,
      limit: 50,
    });
  });

  it("reads includeArchived and limit from strings", () => {
    expect(
      ListSpacesQuerySchema.parse({ includeArchived: "true", limit: "100" })
    ).toMatchObject({ includeArchived: true, limit: 100 });
  });

  it.each([
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { includeArchived: "1" },
    { membership: "everyone" },
    { kind: ["a", "b"] },
    { other: "x" },
  ])("rejects %j", (query) => {
    expect(ListSpacesQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("SpaceCursorSchema", () => {
  it("accepts an ISO timestamp and an id", () => {
    expect(
      SpaceCursorSchema.safeParse([new Date().toISOString(), uuidv7()]).success
    ).toBe(true);
  });

  it.each([
    [[1, uuidv7()]],
    [["yesterday", uuidv7()]],
    [[new Date().toISOString(), "not-an-id"]],
    [[new Date().toISOString(), 7]],
  ])("rejects %j", (values) => {
    expect(SpaceCursorSchema.safeParse(values).success).toBe(false);
  });

  it("lower-cases the id", () => {
    const stamp = new Date().toISOString();

    expect(SpaceCursorSchema.parse([stamp, uuidv7().toUpperCase()])).toEqual([
      stamp,
      expect.stringMatching(/^[0-9a-f-]+$/),
    ]);
  });
});
