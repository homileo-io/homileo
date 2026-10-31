// @module-tag unit
// @module-tag sessions
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  CreateSessionBodySchema,
  ListSessionsQuerySchema,
} from "../../../../routes/v1/sessions/schemas.js";

const ID = uuidv7();

describe("POST /v1/sessions body", () => {
  it.each([
    ["an unknown key", { extra: 1 }],
    ["a spaceId that is not a UUID", { spaceId: "nope" }],
    ["an empty name", { name: "" }],
    ["a name over 255 characters", { name: "x".repeat(256) }],
    ["an unknown access", { access: "everyone" }],
    [
      "101 participants",
      { participantIds: Array.from({ length: 101 }, () => uuidv7()) },
    ],
    ["a participant that is not a UUID", { participantIds: ["nope"] }],
    ["duplicate participants", { participantIds: [ID, ID] }],
    [
      "participants differing only in case",
      { participantIds: [ID, ID.toUpperCase()] },
    ],
    ["a state over 64 characters", { state: "s".repeat(65) }],
    ["an empty externalRef", { externalRef: "" }],
    ["an externalRef over 255 characters", { externalRef: "r".repeat(256) }],
    ["a nested metadata value key", { metadata: { "1bad": 1 } }],
    ["metadata that is not an object", { metadata: [1] }],
  ])("rejects %s", (_name, body) => {
    expect(CreateSessionBodySchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["an empty body", {}],
    [
      "every field",
      {
        spaceId: ID,
        name: "n",
        access: "members",
        participantIds: [ID],
        state: "open",
        externalRef: "r",
        metadata: { a: 1 },
      },
    ],
    [
      "100 participants",
      { participantIds: Array.from({ length: 100 }, () => uuidv7()) },
    ],
  ])("accepts %s", (_name, body) => {
    expect(CreateSessionBodySchema.safeParse(body).success).toBe(true);
  });
});

describe("ids", () => {
  it("are lower-cased at parse time", () => {
    const parsed = CreateSessionBodySchema.parse({
      spaceId: ID.toUpperCase(),
      participantIds: [ID.toUpperCase()],
    });
    expect(parsed).toEqual({ spaceId: ID, participantIds: [ID] });
    expect(
      ListSessionsQuerySchema.parse({ spaceId: ID.toUpperCase() }).spaceId
    ).toBe(ID);
  });
});

describe("GET /v1/sessions query", () => {
  it.each([
    ["a bad spaceId", { spaceId: "nope" }],
    ["an unknown type", { type: "channel" }],
    ["includeArchived that is not true or false", { includeArchived: "1" }],
    ["limit 0", { limit: "0" }],
    ["limit 101", { limit: "101" }],
    ["a non-numeric limit", { limit: "x" }],
    ["an empty externalRef", { externalRef: "" }],
    ["an unknown key", { sort: "name" }],
  ])("rejects %s", (_name, query) => {
    expect(ListSessionsQuerySchema.safeParse(query).success).toBe(false);
  });

  it("parses booleans and the limit, defaulting the limit to 50", () => {
    expect(ListSessionsQuerySchema.parse({})).toMatchObject({ limit: 50 });
    expect(
      ListSessionsQuerySchema.parse({ includeArchived: "true", limit: "10" })
    ).toMatchObject({ includeArchived: true, limit: 10 });
    expect(
      ListSessionsQuerySchema.parse({ includeArchived: "false" })
    ).toMatchObject({ includeArchived: false });
  });
});
