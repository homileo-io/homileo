// @module-tag int
// @module-tag search
// @module-tag access
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionKind } from "../../../../support/v1App.js";
import { personToken } from "../../../../support/tokens.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import {
  searchFixtures,
  sessionHitIds,
} from "../../../../support/searchApi.js";

const s = searchFixtures();
const GRANT = "search-sess-perms.cases.read";
const READ = "homileo.spaces.read";
const ADMIN = "homileo.chat.admin";

let org: string;
let ids: Record<string, string>;
let people: Record<string, { tereoUserId: string; perms: string[] }>;
let foreign: string;

const found = async (who: string) => {
  const token = personToken({
    userId: people[who].tereoUserId,
    org,
    perms: people[who].perms,
  });
  const res = await s.searchSessions(token, { q: "probe", limit: "50" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return sessionHitIds(res.body)
    .map((hit) => hit.split(":")[1])
    .sort();
};

beforeAll(async () => {
  await s.start();
  org = s.organization();
  const f = s.fixtures;
  const kind = await provisionKind({
    grants: [{ permission: GRANT, access: "read" }],
  });
  const [holder, outsider, member, admin] = await Promise.all(
    Array.from({ length: 4 }, () => f.principal())
  );
  const spaceA = await f.space({ org, name: "probe A", visibility: "members" });
  const spaceB = await f.space({
    org,
    kind,
    name: "probe B",
    visibility: "members",
  });
  const sessionA = await f.session({ space: spaceA, access: "members" });
  const sessionB = await f.session({ space: spaceB, access: "members" });
  const loose = await f.session({ org });
  await f.member(spaceA, member);
  await f.participant(sessionA, member);
  await f.participant(loose, member);
  ids = {
    spaceA: spaceA.id,
    spaceB: spaceB.id,
    sessionA: sessionA.id,
    sessionB: sessionB.id,
    loose: loose.id,
  };
  for (const t of ["spaces", "sessions"] as const) {
    const rows = Object.values(ids);
    await prisma.$executeRawUnsafe(
      `UPDATE "chat"."${t}" SET search_text = 'probe' WHERE id = ANY($1::uuid[])`,
      rows
    );
  }
  people = {
    outsider: { tereoUserId: outsider.tereoUserId!, perms: [READ] },
    member: { tereoUserId: member.tereoUserId!, perms: [READ] },
    holder: { tereoUserId: holder.tereoUserId!, perms: [READ, GRANT] },
    admin: { tereoUserId: admin.tereoUserId!, perms: [ADMIN] },
  };
  const other = await f.space({
    name: "probe elsewhere",
    visibility: "public",
  });
  await prisma.space.update({
    where: { id: other.id },
    data: { searchText: "probe" },
  });
  foreign = other.id;
});

afterAll(s.cleanup);

describe("GET /v1/search/sessions permissions", () => {
  it("returns neither a members-only space nor its members sessions to a non-member", async () => {
    expect(await found("outsider")).toEqual([]);
  });

  it("returns a member their space and the sessions they participate in", async () => {
    expect(await found("member")).toEqual(
      [ids.spaceA, ids.sessionA, ids.loose].sort()
    );
  });

  it("returns a grant holder the granted kind's space and its sessions", async () => {
    expect(await found("holder")).toEqual([ids.spaceB, ids.sessionB].sort());
  });

  it("returns an admin the spaces and their sessions, but no space-less session", async () => {
    const got = await found("admin");

    expect(got).toEqual(
      [ids.spaceA, ids.spaceB, ids.sessionA, ids.sessionB].sort()
    );
    expect(got).not.toContain(ids.loose);
  });

  it("returns nothing from another organization", async () => {
    for (const who of Object.keys(people)) {
      expect(await found(who)).not.toContain(foreign);
    }
  });
});
