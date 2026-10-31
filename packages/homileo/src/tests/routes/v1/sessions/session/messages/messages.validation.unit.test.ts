// @module-tag unit
// @module-tag sessions
// @module-tag messages
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  ListMessagesQuerySchema,
  SendMessageBodySchema,
} from "../../../../../../routes/v1/sessions/session/messages/schemas.js";

const ID = uuidv7();
const CID = "c-1";

describe("POST /v1/sessions/:sessionId/messages body", () => {
  it.each([
    ["no clientMessageId", { body: "x" }],
    ["an empty clientMessageId", { clientMessageId: "", body: "x" }],
    [
      "a clientMessageId over 128 characters",
      { clientMessageId: "c".repeat(129), body: "x" },
    ],
    ["an unknown key", { clientMessageId: CID, body: "x", extra: 1 }],
    ["neither body nor payload", { clientMessageId: CID }],
    ["a text message without a body", { clientMessageId: CID, type: "text" }],
    [
      "a text message with a payload",
      { clientMessageId: CID, body: "x", payload: { a: 1 } },
    ],
    [
      "a custom type without a payload",
      { clientMessageId: CID, type: "app:card", body: "x" },
    ],
    [
      "a null payload",
      { clientMessageId: CID, type: "app:card", payload: null },
    ],
    [
      "a body over 40,000 characters",
      { clientMessageId: CID, body: "b".repeat(40_001) },
    ],
    ["an empty body", { clientMessageId: CID, body: "" }],
    [
      "a payload over 64 KiB",
      {
        clientMessageId: CID,
        type: "app:card",
        payload: { s: "p".repeat(64 * 1024) },
      },
    ],
    ["an empty type", { clientMessageId: CID, type: "", body: "x" }],
    [
      "a type over 64 characters",
      { clientMessageId: CID, type: "t".repeat(65), payload: {} },
    ],
    [
      "a threadRootId that is not a UUID",
      { clientMessageId: CID, body: "x", threadRootId: "nope" },
    ],
    [
      "metadata with a bad key",
      { clientMessageId: CID, body: "x", metadata: { "1bad": 1 } },
    ],
  ])("rejects %s", (_name, body) => {
    expect(SendMessageBodySchema.safeParse(body).success).toBe(false);
  });

  it.each([
    ["a text message", { clientMessageId: CID, body: "hello" }],
    [
      "a body of exactly 40,000 characters",
      { clientMessageId: CID, body: "b".repeat(40_000) },
    ],
    [
      "a custom type with a payload only",
      { clientMessageId: CID, type: "app:card", payload: { a: 1 } },
    ],
    [
      "a custom type with a payload and a fallback body",
      { clientMessageId: CID, type: "app:card", payload: [1], body: "card" },
    ],
    [
      "every field",
      {
        clientMessageId: "c".repeat(128),
        body: "x",
        metadata: { a: 1 },
        threadRootId: ID,
      },
    ],
  ])("accepts %s", (_name, body) => {
    expect(SendMessageBodySchema.safeParse(body).success).toBe(true);
  });

  it("defaults the type to text and lower-cases threadRootId", () => {
    expect(
      SendMessageBodySchema.parse({
        clientMessageId: CID,
        body: "x",
        threadRootId: ID.toUpperCase(),
      })
    ).toMatchObject({ type: "text", threadRootId: ID });
  });
});

describe("GET /v1/sessions/:sessionId/messages query", () => {
  it.each([
    ["before and after", { before: "3", after: "1" }],
    ["after and around", { after: "3", around: "1" }],
    ["a negative before", { before: "-1" }],
    ["a fractional after", { after: "1.5" }],
    ["a non-numeric around", { around: "x" }],
    ["an empty before", { before: "" }],
    ["a limit of 0", { limit: "0" }],
    ["a limit over 100", { limit: "101" }],
    ["an unknown key", { cursor: "abc" }],
  ])("rejects %s", (_name, query) => {
    expect(ListMessagesQuerySchema.safeParse(query).success).toBe(false);
  });

  it.each([
    ["nothing", {}, { limit: 50 }],
    ["before", { before: "10" }, { before: 10, limit: 50 }],
    ["after 0", { after: "0", limit: "100" }, { after: 0, limit: 100 }],
    ["around", { around: "7", limit: "3" }, { around: 7, limit: 3 }],
  ])("accepts %s", (_name, query, parsed) => {
    expect(ListMessagesQuerySchema.parse(query)).toEqual(parsed);
  });
});
