// @module-tag unit
// @module-tag spaces
import { joinRequestView, memberView, spaceView } from "../../views/index.js";
import { at, id, spaceRow } from "../support/pure/viewRows.js";
import { describe, expect, it } from "vitest";
import {
  JoinRequestSchema,
  SpaceMemberSchema,
  SpaceSchema,
} from "@homileo-io/sdk";

describe("space views", () => {
  it("spaceView output parses with its SDK schema", () => {
    const view = spaceView(spaceRow);
    expect(SpaceSchema.safeParse(view).success).toBe(true);
    expect(view.createdAt).toBe("2026-10-30T12:00:00.000Z");
  });

  it("memberView names the user column principalId", () => {
    const view = memberView({
      spaceId: id(3),
      userId: id(1),
      role: "owner",
      joinedAt: at,
    });
    expect(SpaceMemberSchema.safeParse(view).success).toBe(true);
    expect(view.principalId).toBe(id(1));
  });

  it("joinRequestView output parses with its SDK schema", () => {
    const view = joinRequestView({
      id: id(5),
      spaceId: id(3),
      userId: id(1),
      status: "approved",
      createdAt: at,
      decidedBy: id(2),
      decidedAt: at,
    });
    expect(JoinRequestSchema.safeParse(view).success).toBe(true);
    expect(view.decidedAt).toBe("2026-10-30T12:00:00.000Z");
  });
});
