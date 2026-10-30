// @module-tag unit
// @module-tag access
import { describe, expect, it } from "vitest";
import {
  caller,
  kind,
  session,
  space,
  OTHER_ORG,
} from "../support/pure/policyFacts.js";
import {
  canJoinSession,
  canManageParticipants,
  canPost,
  canReadSession,
} from "../../policy/index.js";

const grants = kind({
  grants: [{ permission: "support.cases.read", access: "read" }],
});
const admin = { isAdmin: true, permissions: ["homileo.chat.admin"] };
const grantHolder = { permissions: ["support.cases.read"] };
const inSpace = (o = {}) => space({ role: "member", ...o });

describe("canReadSession", () => {
  it.each([
    ["space access, member of the space", {}, { space: inSpace() }, true],
    [
      "space access, public space, non-member",
      {},
      { space: space({ visibility: "public" }) },
      true,
    ],
    ["space access, members-only, non-member", {}, {}, false],
    [
      "space access, grant holder",
      grantHolder,
      { space: space({ kind: grants }) },
      true,
    ],
    [
      "members access, participant",
      {},
      { access: "members", participantRole: "member" },
      true,
    ],
    [
      "members access, space member not participant",
      {},
      { access: "members", space: inSpace() },
      false,
    ],
    [
      "members access, public space, not participant",
      {},
      { access: "members", space: space({ visibility: "public" }) },
      false,
    ],
    [
      "members access, grant holder",
      grantHolder,
      { access: "members", space: space({ kind: grants }) },
      true,
    ],
    ["members access, admin", admin, { access: "members" }, true],
    [
      "space-less, participant",
      {},
      { space: null, participantRole: "member" },
      true,
    ],
    ["space-less, not a participant", {}, { space: null }, false],
    ["space-less, admin not a participant", admin, { space: null }, false],
    [
      "space-less, admin participant",
      admin,
      { space: null, participantRole: "member" },
      true,
    ],
    [
      "other organization, participant",
      {},
      { organizationId: OTHER_ORG, space: null, participantRole: "owner" },
      false,
    ],
    [
      "other organization, admin",
      admin,
      { organizationId: OTHER_ORG, access: "members" },
      false,
    ],
    ["archived stays readable", {}, { archived: true, space: inSpace() }, true],
    [
      "grant holder, other organization",
      grantHolder,
      { organizationId: OTHER_ORG, space: space({ kind: grants }) },
      false,
    ],
    [
      "space in another organization than the session",
      admin,
      { space: space({ organizationId: OTHER_ORG, role: "owner" }) },
      false,
    ],
  ])("%s -> %s", (_n, c, ss, want) => {
    expect(canReadSession(caller(c), session(ss))).toBe(want);
  });
});

describe("canJoinSession", () => {
  const pub = (
    joinPolicy: "open" | "request" | "invite",
    role: "member" | null = null
  ) => space({ visibility: "public", joinPolicy, role });
  it.each([
    ["public open space, non-member", { space: pub("open") }, true],
    ["public request space, non-member", { space: pub("request") }, false],
    ["public invite space, non-member", { space: pub("invite") }, false],
    ["member of an invite space", { space: pub("invite", "member") }, true],
    [
      "already a participant",
      { space: pub("invite"), participantRole: "member" },
      true,
    ],
    [
      "members-only session",
      { access: "members", space: pub("open", "member") },
      false,
    ],
    ["space-less", { space: null, access: "members" }, false],
    ["cannot read the space", { space: space({ joinPolicy: "open" }) }, false],
    ["archived session", { archived: true, space: pub("open") }, false],
    ["archived space", { space: { ...pub("open"), archived: true } }, false],
    [
      "other organization",
      { organizationId: OTHER_ORG, space: pub("open") },
      false,
    ],
  ])("%s -> %s", (_n, ss, want) => {
    expect(canJoinSession(caller(), session(ss))).toBe(want);
  });
});

describe("canPost", () => {
  it.each([
    [
      "participant, members policy",
      {},
      { participantRole: "member", space: inSpace() },
      true,
    ],
    ["not a participant", {}, { space: inSpace() }, false],
    ["not a participant, admin", admin, { space: inSpace() }, false],
    [
      "public space, not a member, not a participant",
      {},
      { space: space({ visibility: "public" }) },
      false,
    ],
    [
      "participant who lost read access (members-visibility space, no role)",
      {},
      { participantRole: "member", space: space() },
      false,
    ],
    [
      "moderators policy, grant moderate holder participant",
      { permissions: ["support.cases.moderate"] },
      {
        participantRole: "member",
        space: space({
          postPolicy: "moderators",
          kind: kind({
            grants: [
              { permission: "support.cases.moderate", access: "moderate" },
            ],
          }),
        }),
      },
      true,
    ],
    [
      "moderators policy, moderator who is not a participant",
      {},
      { space: inSpace({ postPolicy: "moderators", role: "moderator" }) },
      false,
    ],
    [
      "moderators policy, member",
      {},
      {
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators" }),
      },
      false,
    ],
    [
      "moderators policy, moderator",
      {},
      {
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators", role: "moderator" }),
      },
      true,
    ],
    [
      "moderators policy, owner",
      {},
      {
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators", role: "owner" }),
      },
      true,
    ],
    [
      "moderators policy, admin participant",
      admin,
      {
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators" }),
      },
      true,
    ],
    [
      "archived session",
      {},
      { participantRole: "member", archived: true, space: inSpace() },
      false,
    ],
    [
      "archived space",
      {},
      { participantRole: "member", space: inSpace({ archived: true }) },
      false,
    ],
    [
      "space-less participant",
      {},
      { participantRole: "member", space: null },
      true,
    ],
    [
      "other organization",
      {},
      { organizationId: OTHER_ORG, participantRole: "owner", space: null },
      false,
    ],
  ])("%s -> %s", (_n, c, ss, want) => {
    expect(canPost(caller(c), session(ss))).toBe(want);
  });

  it("applies the same rules to a bot", () => {
    const bot = caller({ isBot: true });
    const ss = session({
      participantRole: "member",
      space: inSpace({ postPolicy: "moderators" }),
    });
    expect(canPost(bot, ss)).toBe(false);
  });
});

describe("canManageParticipants", () => {
  it.each([
    ["space-less owner", {}, { space: null, participantRole: "owner" }, true],
    [
      "space-less member",
      {},
      { space: null, participantRole: "member" },
      false,
    ],
    ["space-less admin, not a participant", admin, { space: null }, true],
    [
      "space-less admin, other organization",
      admin,
      { space: null, organizationId: OTHER_ORG },
      false,
    ],
    [
      "space-less admin, archived",
      admin,
      { space: null, archived: true },
      false,
    ],
    [
      "grant moderate (moderators remove members)",
      { permissions: ["support.cases.moderate"] },
      {
        space: space({
          kind: kind({
            grants: [
              { permission: "support.cases.moderate", access: "moderate" },
            ],
          }),
        }),
      },
      true,
    ],
    ["grant read", grantHolder, { space: space({ kind: grants }) }, false],
    ["space moderator", {}, { space: inSpace({ role: "moderator" }) }, true],
    ["space member", {}, { space: inSpace() }, false],
    ["space admin", admin, {}, true],
    [
      "archived session",
      {},
      { archived: true, space: null, participantRole: "owner" },
      false,
    ],
    [
      "archived space",
      {},
      { space: inSpace({ role: "owner", archived: true }) },
      false,
    ],
    [
      "other organization",
      {},
      { organizationId: OTHER_ORG, space: null, participantRole: "owner" },
      false,
    ],
  ])("%s -> %s", (_n, c, ss, want) => {
    expect(canManageParticipants(caller(c), session(ss))).toBe(want);
  });
});

describe("bots and grant holders", () => {
  const bot = caller({ isBot: true });

  it("lets a bot participant read and post like a person", () => {
    const ss = session({ participantRole: "member", space: inSpace() });
    expect(canReadSession(bot, ss)).toBe(true);
    expect(canPost(bot, ss)).toBe(true);
  });

  it("refuses a bot that is not a participant", () => {
    const ss = session({ space: inSpace() });
    expect(canPost(bot, ss)).toBe(false);
  });

  it.each([
    ["grant holder, members-visibility open space", grantHolder, true],
    ["admin, members-visibility open space", admin, true],
    ["plain user, members-visibility open space", {}, false],
  ])("canJoinSession: %s -> %s", (_n, c, want) => {
    const ss = session({
      space: space({ kind: grants, joinPolicy: "open" }),
    });
    expect(canJoinSession(caller(c), ss)).toBe(want);
  });

  it("refuses a grant holder from another organization everywhere", () => {
    const c = caller({
      organizationId: OTHER_ORG,
      permissions: ["support.cases.read"],
    });
    const ss = session({ space: space({ kind: grants, joinPolicy: "open" }) });
    expect(canReadSession(c, ss)).toBe(false);
    expect(canJoinSession(c, ss)).toBe(false);
  });
});
