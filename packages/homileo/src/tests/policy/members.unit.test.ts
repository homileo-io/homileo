// @module-tag unit
// @module-tag access
import { caller, space, OTHER_ORG } from "../support/pure/policyFacts.js";
import type { MemberChange } from "../../policy/index.js";
import { canChangeMember } from "../../policy/index.js";
import { describe, expect, it } from "vitest";

const add = (to: MemberChange["to"]): MemberChange => ({
  from: null,
  to,
  self: false,
});
const remove = (from: MemberChange["from"]): MemberChange => ({
  from,
  to: null,
  self: false,
});
const change = (
  from: MemberChange["from"],
  to: MemberChange["to"]
): MemberChange => ({ from, to, self: false });
const leave = (from: MemberChange["from"]): MemberChange => ({
  from,
  to: null,
  self: true,
});

describe("canChangeMember", () => {
  it.each([
    ["moderator adds a member", "moderator", add("member"), true],
    ["moderator adds a moderator", "moderator", add("moderator"), false],
    ["moderator adds an owner", "moderator", add("owner"), false],
    ["owner adds a moderator", "owner", add("moderator"), true],
    ["owner adds an owner", "owner", add("owner"), true],
    ["plain member adds a member", "member", add("member"), false],
    ["non-member adds a member", null, add("member"), false],
    ["moderator removes a member", "moderator", remove("member"), true],
    ["moderator removes a moderator", "moderator", remove("moderator"), false],
    ["moderator removes an owner", "moderator", remove("owner"), false],
    ["owner removes a moderator", "owner", remove("moderator"), true],
    ["owner removes an owner", "owner", remove("owner"), true],
    ["plain member removes a member", "member", remove("member"), false],
    [
      "moderator demotes an owner",
      "moderator",
      change("owner", "member"),
      false,
    ],
    [
      "moderator promotes a member",
      "moderator",
      change("member", "owner"),
      false,
    ],
    [
      "owner promotes a member to owner",
      "owner",
      change("member", "owner"),
      true,
    ],
    ["owner demotes a moderator", "owner", change("moderator", "member"), true],
    ["member leaves", "member", leave("member"), true],
    ["moderator leaves", "moderator", leave("moderator"), true],
    ["owner leaves", "owner", leave("owner"), true],
    ["non-member 'leaves'", null, leave(null), false],
  ])("%s", (_n, role, ch, want) => {
    expect(canChangeMember(caller(), space({ role }), ch)).toBe(want);
  });

  it("lets a kind grant holder who moderates add members but not owners", () => {
    const s = space({
      kind: {
        ...space().kind,
        grants: [{ permission: "support.cases.moderate", access: "moderate" }],
      },
    });
    const c = caller({ permissions: ["support.cases.moderate"] });
    expect(canChangeMember(c, s, add("member"))).toBe(true);
    expect(canChangeMember(c, s, add("owner"))).toBe(false);
  });

  it.each([
    ["add a member", add("member")],
    ["add an owner", add("owner")],
    ["remove an owner", remove("owner")],
    ["demote an owner", change("owner", "member")],
    ["promote a member", change("member", "owner")],
    ["leave", leave("member")],
  ])("lets an admin %s without membership", (_n, ch) => {
    const c = caller({ isAdmin: true, permissions: ["homileo.chat.admin"] });
    expect(canChangeMember(c, space(), ch)).toBe(true);
  });

  it("refuses every change in another organization, an admin's included", () => {
    const c = caller({ isAdmin: true });
    const s = space({ organizationId: OTHER_ORG, role: "owner" });
    for (const ch of [add("member"), remove("owner"), leave("owner")]) {
      expect(canChangeMember(c, s, ch)).toBe(false);
    }
  });

  it("refuses other changes in an archived space but still lets a member leave", () => {
    const s = space({ role: "owner", archived: true });
    expect(canChangeMember(caller(), s, add("member"))).toBe(false);
    expect(canChangeMember(caller(), s, change("member", "owner"))).toBe(false);
    expect(canChangeMember(caller(), s, leave("owner"))).toBe(true);
  });
});
