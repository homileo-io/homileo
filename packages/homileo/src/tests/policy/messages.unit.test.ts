// @module-tag unit
// @module-tag access
import type { MessageFacts } from "../../policy/index.js";
import { describe, expect, it } from "vitest";
import {
  caller,
  kind,
  session,
  space,
  OTHER_ORG,
} from "../support/pure/policyFacts.js";
import {
  canDeleteMessage,
  canEditMessage,
  canReadRevisions,
  editWindowOpen,
  isMentionReader,
} from "../../policy/index.js";

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
    [
      "sender who left an access: space session, still readable",
      session({
        access: "space",
        participantRole: null,
        space: space({ role: "member" }),
      }),
      message(),
      false,
    ],
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

  it("refuses a removed participant their own delete, though they can still read", () => {
    const ss = session({
      access: "space",
      participantRole: null,
      space: space({ role: "member" }),
    });
    expect(canDeleteMessage(caller(), ss, message())).toBe(false);
  });

  it("still lets a moderator who left delete", () => {
    const ss = session({
      participantRole: null,
      space: space({ role: "moderator" }),
    });
    expect(canDeleteMessage(caller(), ss, message())).toBe(true);
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

  it("lets an admin delete in a members-access session without participating", () => {
    const ss = session({ access: "members", space: space() });
    const c = caller({ isAdmin: true });
    expect(canDeleteMessage(c, ss, message({ senderId: "someone" }))).toBe(
      true
    );
  });

  it("refuses edit and delete in another organization", () => {
    const ss = {
      ...inSession(null, "moderator"),
      organizationId: OTHER_ORG,
      space: space({ role: "moderator", organizationId: OTHER_ORG }),
    };
    expect(canEditMessage(caller(), ss, message(), NOW)).toBe(false);
    expect(canDeleteMessage(caller(), ss, message())).toBe(false);
  });

  it("lets a bot sender edit its own message", () => {
    const bot = caller({ isBot: true });
    expect(canEditMessage(bot, inSession(60), message(), NOW)).toBe(true);
  });

  it("gives a space-less non-sender no delete, even an admin", () => {
    const ss = session({ space: null, participantRole: "owner" });
    const c = caller({ isAdmin: true });
    expect(canDeleteMessage(c, ss, message({ senderId: "someone" }))).toBe(
      false
    );
  });
});

describe("canReadRevisions", () => {
  const other = message({ senderId: "someone" });
  it.each([
    ["sender", inSession(null), message(), caller(), true],
    [
      "deleted message, sender",
      inSession(null),
      message({ deleted: true }),
      caller(),
      true,
    ],
    ["non-sender member", inSession(null), other, caller(), false],
    [
      "moderator, any message",
      inSession(null, "moderator"),
      other,
      caller(),
      true,
    ],
    [
      "moderator, deleted message",
      inSession(null, "moderator"),
      message({ senderId: "someone", deleted: true }),
      caller(),
      true,
    ],
    [
      "sender who left, still readable",
      session({ participantRole: null, space: space({ role: "member" }) }),
      message(),
      caller(),
      true,
    ],
    [
      "sender who cannot read",
      session({ space: space() }),
      message(),
      caller(),
      false,
    ],
    [
      "grant moderator",
      session({
        space: space({
          kind: kind({
            grants: [
              { permission: "support.cases.moderate", access: "moderate" },
            ],
          }),
        }),
      }),
      other,
      caller({ permissions: ["support.cases.moderate"] }),
      true,
    ],
    [
      "admin in a space's session",
      session({ access: "members", space: space() }),
      other,
      caller({ isAdmin: true }),
      true,
    ],
    [
      "space-less owner, not the sender",
      session({ space: null, participantRole: "owner" }),
      other,
      caller(),
      false,
    ],
    [
      "space-less admin participant, not the sender",
      session({ space: null, participantRole: "member" }),
      other,
      caller({ isAdmin: true }),
      false,
    ],
    [
      "another organization",
      session({
        organizationId: OTHER_ORG,
        participantRole: "member",
        space: space({ role: "moderator", organizationId: OTHER_ORG }),
      }),
      message(),
      caller(),
      false,
    ],
  ])("%s -> %s", (_n, ss, m, c, want) => {
    expect(canReadRevisions(c, ss, m)).toBe(want);
  });
});

describe("editWindowOpen", () => {
  it.each([
    ["inside", inSession(60), message({ createdAt: ago(30) }), true],
    ["at the edge", inSession(60), message({ createdAt: ago(60) }), true],
    ["past", inSession(60), message({ createdAt: ago(61) }), false],
    ["no limit", inSession(null), message({ createdAt: ago(9e6) }), true],
    [
      "space-less",
      session({ space: null, participantRole: "member" }),
      message({ createdAt: ago(9e6) }),
      true,
    ],
  ])("%s -> %s", (_n, ss, m, want) => {
    expect(editWindowOpen(ss, m, NOW)).toBe(want);
  });
});

describe("isMentionReader", () => {
  const spaceSession = (access: "space" | "members", visibility = "public") =>
    session({ access, space: space({ visibility }) });

  it.each([
    [
      "a participant of a space-less session",
      session({ space: null }),
      "member",
      null,
      true,
    ],
    [
      "a non-participant of a space-less session",
      session({ space: null }),
      null,
      null,
      false,
    ],
    [
      "a space member in an access: space session",
      spaceSession("space"),
      null,
      "member",
      true,
    ],
    [
      "a non-member of a public space's access: space session",
      spaceSession("space"),
      null,
      null,
      false,
    ],
    [
      "a space member in an access: members session",
      spaceSession("members"),
      null,
      "member",
      false,
    ],
    [
      "a participant of an access: members session",
      spaceSession("members"),
      "member",
      null,
      true,
    ],
  ] as const)("%s → %s", (_name, ss, participantRole, spaceRole, expected) => {
    expect(isMentionReader(ss, { participantRole, spaceRole })).toBe(expected);
  });
});
