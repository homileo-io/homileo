// @module-tag unit
// @module-tag messages
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  EditMessageBodySchema,
  MessageParamsSchema,
} from "../../../../../routes/v1/messages/schemas.js";

describe("PATCH /v1/messages/:messageId body", () => {
  it.each([
    ["an empty body", {}],
    ["an empty text", { body: "" }],
    ["a body over 40,000 characters", { body: "x".repeat(40_001) }],
    ["a null payload", { payload: null }],
    ["a payload over 64 KiB", { payload: { a: "x".repeat(70_000) } }],
    [
      "metadata with 51 keys",
      {
        metadata: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`k${i}`, i])
        ),
      },
    ],
    ["a bad metadata key", { metadata: { "1a": "x" } }],
    ["a field it does not know", { body: "x", type: "text" }],
    ["a non-string body", { body: 5 }],
  ])("refuses %s", (_name, input) => {
    expect(EditMessageBodySchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["a body", { body: "x" }],
    ["a payload", { payload: { a: 1 } }],
    ["metadata", { metadata: {} }],
    ["all three", { body: "x", payload: [1], metadata: { a: "b" } }],
  ])("accepts %s", (_name, input) => {
    expect(EditMessageBodySchema.safeParse(input).success).toBe(true);
  });
});

describe("message id param", () => {
  it("lower-cases a uuid and refuses anything else", () => {
    const id = uuidv7();
    expect(
      MessageParamsSchema.parse({ messageId: id.toUpperCase() }).messageId
    ).toBe(id);
    expect(MessageParamsSchema.safeParse({ messageId: "nope" }).success).toBe(
      false
    );
  });
});
