// @module-tag unit
// @module-tag sessions
import { participantView, sessionView } from "../../views/index.js";
import { ParticipantSchema, SessionSchema } from "@homileo-io/sdk";
import { at, id, sessionRow } from "../support/pure/viewRows.js";
import { describe, expect, it } from "vitest";

describe("session views", () => {
  it("sessionView turns bigint lastSeq into a number", () => {
    const view = sessionView(sessionRow);
    expect(SessionSchema.safeParse(view).success).toBe(true);
    expect(view.lastSeq).toBe(12);
    expect(view).not.toHaveProperty("directKey");
  });

  it("participantView turns bigint lastReadSeq into a number", () => {
    const view = participantView({
      sessionId: id(6),
      userId: id(1),
      role: "owner",
      lastReadSeq: 3n,
      notify: "all",
      joinedAt: at,
      leftAt: null,
    });
    expect(ParticipantSchema.safeParse(view).success).toBe(true);
    expect(view.lastReadSeq).toBe(3);
    expect(view.principalId).toBe(id(1));
  });
});
