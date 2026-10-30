// @module-tag unit
// @module-tag access
import { caller, kind, session, space } from "../support/pure/policyFacts.js";
import { canDeleteMessage, canEditMessage } from "../../policy/index.js";
import type { MessageFacts } from "../../policy/index.js";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-10-30T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

const message = (o: Partial<MessageFacts> = {}): MessageFacts => ({
  senderId: "p-caller",
  createdAt: ago(10),
  deleted: false,
  ...o,
});
const inSession = (
  windowSeconds: number | null,
  role: "member" | "moderator" = "member"
) =>
  session({
    participantRole: "member",
    space: space({ role, kind: kind({ editWindowSeconds: windowSeconds }) }),
  });

describe("canEditMessage", () => {
  it.each([
    ["sender within the window", inSession(60), message(), true],
    [
      "sender at the window's edge",
      inSession(60),
      message({ createdAt: ago(60) }),
      true,
    ],
    [
      "sender past the window",
      inSession(60),
      message({ createdAt: ago(61) }),
      false,
    ],
    [
      "no window, a year later",
      inSession(null),
      message({ createdAt: ago(366 * 86400) }),
      true,
    ],
    [
      "non-sender member",
      inSession(null),
      message({ senderId: "someone" }),
      false,
    ],
    [
      "moderator, not the sender",
      inSession(null, "moderator"),
      message({ senderId: "someone" }),
      false,
    ],
    ["deleted message", inSession(null), message({ deleted: true }), false],
    [
      "archived session",
      { ...inSession(null), archived: true },
      message(),
      false,
    ],
    ["sender who lost access", session({ space: space() }), message(), false],
  ])("%s -> %s", (_n, ss, m, want) => {
    expect(canEditMessage(caller(), ss, m, NOW)).toBe(want);
  });

  it("uses no window for a space-less session", () => {
    const ss = session({ space: null, participantRole: "member" });
    expect(
      canEditMessage(
        caller(),
        ss,
        message({ createdAt: ago(366 * 86400) }),
        NOW
      )
    ).toBe(true);
  });
});

describe("canDeleteMessage", () => {
  it.each([
    ["sender", inSession(60), message(), true],
    [
      "sender past the edit window",
      inSession(60),
      message({ createdAt: ago(9999) }),
      true,
    ],
    [
      "non-sender member",
      inSession(null),
      message({ senderId: "someone" }),
      false,
    ],
    [
      "moderator, any message",
      inSession(null, "moderator"),
      message({ senderId: "someone" }),
      true,
    ],
    [
      "already deleted",
      inSession(null, "moderator"),
      message({ deleted: true }),
      false,
    ],
    [
      "archived session",
      { ...inSession(null, "moderator"), archived: true },
      message(),
      false,
    ],
  ])("%s -> %s", (_n, ss, m, want) => {
    expect(canDeleteMessage(caller(), ss, m)).toBe(want);
  });

  it("lets a grant holder delete in a session they can read", () => {
    const k = kind({
      grants: [{ permission: "support.cases.moderate", access: "moderate" }],
    });
    const ss = session({ space: space({ kind: k }) });
    const c = caller({ permissions: ["support.cases.moderate"] });
    expect(canDeleteMessage(c, ss, message({ senderId: "someone" }))).toBe(
      true
    );
  });

  it("gives a space-less non-sender no delete, even an admin", () => {
    const ss = session({ space: null, participantRole: "owner" });
    const c = caller({ isAdmin: true });
    expect(canDeleteMessage(c, ss, message({ senderId: "someone" }))).toBe(
      false
    );
  });
});
