// @module-tag unit
// @module-tag spaces
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  JoinRequestCursorSchema,
  ListJoinRequestsQuerySchema,
} from "../../../../../../routes/v1/spaces/space/join-requests/schemas.js";

describe("ListJoinRequestsQuerySchema", () => {
  it("defaults to pending requests, 50 to a page", () => {
    expect(ListJoinRequestsQuerySchema.parse({})).toEqual({
      status: "pending",
      limit: 50,
    });
  });

  it.each([
    ["an unknown status", { status: "old" }],
    ["a limit of 0", { limit: "0" }],
    ["an unknown parameter", { role: "member" }],
  ])("rejects %s", (_label, query) => {
    expect(ListJoinRequestsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("JoinRequestCursorSchema", () => {
  it("accepts a timestamp and an id and rejects anything else", () => {
    expect(
      JoinRequestCursorSchema.safeParse([new Date().toISOString(), uuidv7()])
        .success
    ).toBe(true);
    expect(JoinRequestCursorSchema.safeParse([1, 2]).success).toBe(false);
  });
});
