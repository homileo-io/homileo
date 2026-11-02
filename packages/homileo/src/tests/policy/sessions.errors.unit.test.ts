// @module-tag unit
// @module-tag access
import { describe, expect, it } from "vitest";
import {
  caller,
  session,
  space,
  OTHER_ORG,
} from "../support/pure/policyFacts.js";
import {
  canCreateSessionIn,
  canPost,
  createSessionRefusal,
  postRefusal,
  reactRefusal,
} from "../../policy/index.js";

const admin = { isAdmin: true, permissions: ["homileo.chat.admin"] };
const inSpace = (o = {}) => space({ role: "member", ...o });

describe("canCreateSessionIn and createSessionRefusal", () => {
  it.each([
    ["member", space({ role: "member" }), {}, null],
    ["non-member", space(), {}, "not_a_member"],
    ["moderator", space({ role: "moderator" }), {}, null],
    ["admin non-member", space(), admin, null],
    [
      "archived space",
      space({ role: "owner", archived: true }),
      {},
      "archived",
    ],
    [
      "member of a moderators posting space",
      space({ role: "member", postPolicy: "moderators" }),
      {},
      "posting_restricted",
    ],
    [
      "non-member of a moderators posting space",
      space({ postPolicy: "moderators" }),
      {},
      "posting_restricted",
    ],
    [
      "moderator of a moderators posting space",
      space({ role: "moderator", postPolicy: "moderators" }),
      {},
      null,
    ],
    [
      "other organization",
      space({ role: "owner", organizationId: OTHER_ORG }),
      {},
      "not_found",
    ],
  ])("%s -> %s", (_n, s, c, want) => {
    expect(createSessionRefusal(caller(c), s)).toBe(want);
    expect(canCreateSessionIn(caller(c), s)).toBe(want === null);
  });
});

describe("postRefusal", () => {
  const readable = { participantRole: "member", space: inSpace() };
  it.each([
    ["cannot read", session({ space: space() }), {}, "not_found"],
    [
      "other organization",
      session({ organizationId: OTHER_ORG }),
      {},
      "not_found",
    ],
    [
      "archived and unreadable reports not_found",
      session({ archived: true, space: space() }),
      {},
      "not_found",
    ],
    [
      "archived session",
      session({ ...readable, archived: true }),
      {},
      "archived",
    ],
    [
      "archived space",
      session({
        participantRole: "member",
        space: inSpace({ archived: true }),
      }),
      {},
      "archived",
    ],
    [
      "archived, not a participant",
      session({ space: inSpace(), archived: true }),
      {},
      "archived",
    ],
    [
      "readable, not a participant",
      session({ space: inSpace() }),
      {},
      "not_a_participant",
    ],
    [
      "moderators posting, plain participant",
      session({
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators" }),
      }),
      {},
      "posting_restricted",
    ],
    ["may post", session(readable), {}, null],
  ])("%s -> %s", (_n, ss, c, want) => {
    expect(postRefusal(caller(c), ss)).toBe(want);
  });

  it("is null exactly when canPost is true", () => {
    const roles = [null, "member", "moderator"];
    for (const org of [undefined, OTHER_ORG])
      for (const archived of [false, true])
        for (const participantRole of [null, "member", "owner"])
          for (const postPolicy of ["members", "moderators"])
            for (const role of roles)
              for (const access of ["space", "members"])
                for (const hasSpace of [true, false])
                  for (const c of [{}, admin]) {
                    const ss = session({
                      ...(org ? { organizationId: org } : {}),
                      archived,
                      participantRole,
                      access,
                      space: hasSpace ? space({ role, postPolicy }) : null,
                    });
                    expect(postRefusal(caller(c), ss) === null).toBe(
                      canPost(caller(c), ss)
                    );
                  }
  });
});

describe("reactRefusal", () => {
  it.each([
    ["cannot read", session({ space: space() }), "not_found"],
    [
      "members-session participant who lost read on the space",
      session({ participantRole: "member", access: "members", space: space() }),
      "not_found",
    ],
    [
      "archived space",
      session({
        participantRole: "member",
        space: inSpace({ archived: true }),
      }),
      "archived",
    ],
    [
      "readable, not a participant",
      session({ space: inSpace() }),
      "not_a_participant",
    ],
    [
      "moderators posting, plain participant",
      session({
        participantRole: "member",
        space: inSpace({ postPolicy: "moderators" }),
      }),
      null,
    ],
  ])("%s -> %s", (_n, ss, want) => {
    expect(reactRefusal(caller(), ss)).toBe(want);
  });
});
