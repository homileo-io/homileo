// @module-tag unit
// @module-tag access
import { caller, kind, space, OTHER_ORG } from "../support/pure/policyFacts.js";
import { describe, expect, it } from "vitest";
import {
  canManageSpace,
  canModerateSpace,
  canReadSpace,
  joinSpaceOutcome,
} from "../../policy/index.js";

const grants = kind({
  grants: [
    { permission: "support.cases.read", access: "read" },
    { permission: "support.cases.moderate", access: "moderate" },
  ],
});
const admin = { isAdmin: true, permissions: ["homileo.chat.admin"] };
const holds = (p: string) => ({ permissions: [p] });

describe("canReadSpace", () => {
  it.each([
    ["no membership, members-only", {}, {}, false],
    ["member", {}, { role: "member" }, true],
    ["public, not a member", {}, { visibility: "public" }, true],
    ["grant read", holds("support.cases.read"), { kind: grants }, true],
    ["grant moderate", holds("support.cases.moderate"), { kind: grants }, true],
    ["unrelated permission", holds("other.read"), { kind: grants }, false],
    ["admin", admin, {}, true],
    ["admin, other organization", admin, { organizationId: OTHER_ORG }, false],
    [
      "owner, other organization",
      {},
      { role: "owner", organizationId: OTHER_ORG },
      false,
    ],
    [
      "public, other organization",
      {},
      { visibility: "public", organizationId: OTHER_ORG },
      false,
    ],
    ["archived stays readable", {}, { role: "member", archived: true }, true],
  ])("%s -> %s", (_n, c, s, want) => {
    expect(canReadSpace(caller(c), space(s))).toBe(want);
  });
});

describe("canModerateSpace", () => {
  it.each([
    ["no role", {}, {}, false],
    ["member", {}, { role: "member" }, false],
    ["public, not a member", {}, { visibility: "public" }, false],
    ["moderator", {}, { role: "moderator" }, true],
    ["owner", {}, { role: "owner" }, true],
    ["grant read", holds("support.cases.read"), { kind: grants }, false],
    ["grant moderate", holds("support.cases.moderate"), { kind: grants }, true],
    ["admin", admin, {}, true],
    ["admin, other organization", admin, { organizationId: OTHER_ORG }, false],
    [
      "owner, other organization",
      {},
      { role: "owner", organizationId: OTHER_ORG },
      false,
    ],
  ])("%s -> %s", (_n, c, s, want) => {
    expect(canModerateSpace(caller(c), space(s))).toBe(want);
  });
});

describe("canManageSpace", () => {
  it.each([
    ["no role", {}, {}, false],
    ["moderator", {}, { role: "moderator" }, false],
    [
      "grant moderate",
      holds("support.cases.moderate"),
      { kind: grants },
      false,
    ],
    ["owner", {}, { role: "owner" }, true],
    ["admin", admin, {}, true],
    ["admin, other organization", admin, { organizationId: OTHER_ORG }, false],
    [
      "owner, other organization",
      {},
      { role: "owner", organizationId: OTHER_ORG },
      false,
    ],
  ])("%s -> %s", (_n, c, s, want) => {
    expect(canManageSpace(caller(c), space(s))).toBe(want);
  });
});

describe("joinSpaceOutcome", () => {
  it.each([
    ["open", { visibility: "public", joinPolicy: "open" }, "join"],
    ["request", { visibility: "public", joinPolicy: "request" }, "request"],
    ["invite", { visibility: "public", joinPolicy: "invite" }, "forbidden"],
    [
      "already a member, invite",
      { role: "member", joinPolicy: "invite" },
      "join",
    ],
    ["cannot read (members-only, open)", { joinPolicy: "open" }, "forbidden"],
    [
      "archived, open",
      { visibility: "public", joinPolicy: "open", archived: true },
      "forbidden",
    ],
    [
      "archived, already a member",
      { role: "member", archived: true },
      "forbidden",
    ],
    [
      "other organization",
      { visibility: "public", joinPolicy: "open", organizationId: OTHER_ORG },
      "forbidden",
    ],
  ])("%s -> %s", (_n, s, want) => {
    expect(joinSpaceOutcome(caller(), space(s))).toBe(want);
  });

  it("lets a grant holder join an open members-only space", () => {
    const c = caller(holds("support.cases.read"));
    expect(
      joinSpaceOutcome(c, space({ kind: grants, joinPolicy: "open" }))
    ).toBe("join");
  });
});
