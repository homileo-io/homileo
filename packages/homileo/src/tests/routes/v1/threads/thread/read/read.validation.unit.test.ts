// @module-tag unit
// @module-tag messages
import { ThreadReadBodySchema } from "../../../../../../routes/v1/threads/thread/read/schemas.js";
import { describe, expect, it } from "vitest";

describe("PUT /v1/threads/:rootId/read body", () => {
  it("takes a non-negative integer seq", () => {
    expect(ThreadReadBodySchema.parse({ seq: 0 })).toEqual({ seq: 0 });
  });

  it.each([{ seq: -1 }, { seq: 1.5 }, { seq: "1" }, {}, { seq: 1, x: 1 }])(
    "refuses %j",
    (input) => {
      expect(ThreadReadBodySchema.safeParse(input).success).toBe(false);
    }
  );
});
