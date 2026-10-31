// @module-tag unit
// @module-tag messages
import { FollowBodySchema } from "../../../../../../routes/v1/threads/thread/follow/schemas.js";
import { describe, expect, it } from "vitest";

describe("PUT /v1/threads/:rootId/follow body", () => {
  it("takes a boolean", () => {
    expect(FollowBodySchema.parse({ following: false })).toEqual({
      following: false,
    });
  });

  it.each([{}, { following: "yes" }, { following: true, x: 1 }])(
    "refuses %j",
    (input) => {
      expect(FollowBodySchema.safeParse(input).success).toBe(false);
    }
  );
});
