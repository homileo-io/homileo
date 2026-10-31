// @module-tag unit
// @module-tag messages
import { ThreadQuerySchema } from "../../../../../../routes/v1/messages/message/thread/schemas.js";
import { describe, expect, it } from "vitest";

describe("GET /v1/messages/:messageId/thread query", () => {
  it("defaults after to 0 and limit to 50", () => {
    expect(ThreadQuerySchema.parse({})).toEqual({ after: 0, limit: 50 });
  });

  it.each([
    ["a negative after", { after: "-1" }],
    ["a fractional after", { after: "1.5" }],
    ["a limit of 0", { limit: "0" }],
    ["a limit over 100", { limit: "101" }],
    ["a key it does not know", { before: "1" }],
  ])("refuses %s", (_n, input) => {
    expect(ThreadQuerySchema.safeParse(input).success).toBe(false);
  });
});
