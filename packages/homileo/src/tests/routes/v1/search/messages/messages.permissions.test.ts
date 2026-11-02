// @module-tag int
// @module-tag search
// @module-tag access
import type { Principal } from "../../../../../../prisma/generated/client/index.js";
import { hitIds, searchFixtures } from "../../../../support/searchApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readableSessions } from "../../../../../utils/access.js";
import type { Caller } from "../../../../../middleware/auth.js";
import { provisionKind } from "../../../../support/v1App.js";
import { personToken } from "../../../../support/tokens.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

const s = searchFixtures();
const GRANT = "search-perms.cases.read";
const READ = "homileo.spaces.read";
const ADMIN = "homileo.chat.admin";

let org: string;
let sessionIds: Record<string, string>;
/** Each session's one message, by session id. */
let messageOf: Map<string, string>;
let foreignMessage: string;
/** Each session's message found only by its attachment's file name, by session id. */
let fileMessageOf: Map<string, string>;
let foreignFileMessage: string;
let people: Record<string, { principal: Principal; perms: string[] }>;

const tokenOf = (who: string) =>
  personToken({
    userId: people[who].principal.tereoUserId!,
    org,
    perms: people[who].perms,
  });

const callerOf = (who: string): Caller => ({
  principalId: people[who].principal.id,
  tereoUserId: people[who].principal.tereoUserId!,
  isBot: false,
  permissions: people[who].perms,
  isAdmin: people[who].perms.includes(ADMIN),
  organizationId: org,
});

const searchAs = async (who: string, q = "probe") => {
  const res = await s.search(tokenOf(who), { q, limit: "50" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return hitIds(res.body);
};

// A: members-only, default kind. B: members-only, a kind granting GRANT read. C: public. And a DM.
beforeAll(async () => {
  await s.start();
  org = s.organization();
  const f = s.fixtures;
  const kind = await provisionKind({
    grants: [{ permission: GRANT, access: "read" }],
  });
  const spaces = {
    A: await f.space({ org, visibility: "members" }),
    B: await f.space({ org, kind, visibility: "members" }),
    C: await f.space({ org, visibility: "public" }),
  };
  const sessions: Record<string, { id: string }> = {};
  for (const name of ["A", "B", "C"] as const) {
    for (const access of ["space", "members"] as const) {
      sessions[`${name}.${access}`] = await f.session({
        space: spaces[name],
        access,
      });
    }
  }
  sessions.group = await f.session({ org });
  const [outsider, member, participant, holder, admin, dmA, dmB] =
    await Promise.all(Array.from({ length: 7 }, () => f.principal()));
  // The organization's sessions are removed by cleanup, this one included.
  sessions.dm = await prisma.session.create({
    data: {
      organizationId: org,
      type: "direct",
      directKey: uuidv7(),
      createdBy: dmA.id,
    },
  });
  await f.member(spaces.A, member);
  await f.participant(sessions["A.members"], member);
  await f.participant(sessions["C.members"], participant);
  await f.participant(sessions.group, participant);
  await f.participant(sessions.dm, dmA);
  await f.participant(sessions.dm, dmB);
  people = {
    outsider: { principal: outsider, perms: [READ] },
    member: { principal: member, perms: [READ] },
    participant: { principal: participant, perms: [READ] },
    holder: { principal: holder, perms: [READ, GRANT] },
    admin: { principal: admin, perms: [ADMIN] },
    dm: { principal: dmA, perms: [READ] },
  };

  sessionIds = Object.fromEntries(
    Object.entries(sessions).map(([k, v]) => [k, v.id])
  );
  messageOf = new Map();
  fileMessageOf = new Map();
  for (const id of Object.values(sessionIds)) {
    messageOf.set(id, await s.insert({ id }, dmA.id, "probe text"));
    const fileOnly = await s.insert({ id }, dmA.id, null);
    await s.attach(fileOnly, "zephyrledger.pdf");
    fileMessageOf.set(id, fileOnly);
  }

  // The same text in another organization's public space.
  const elsewhere = await f.space({ visibility: "public" });
  const foreign = await f.session({ space: elsewhere, access: "space" });
  foreignMessage = await s.insert(foreign, dmA.id, "probe text");
  foreignFileMessage = await s.insert(foreign, dmA.id, null);
  await s.attach(foreignFileMessage, "zephyrledger.pdf");
});

afterAll(s.cleanup);

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe("GET /v1/search/messages permissions", () => {
  it.each(["outsider", "member", "participant", "holder", "admin", "dm"])(
    "finds for %s exactly the messages of the sessions it can read",
    async (who) => {
      const readable = await readableSessions(
        callerOf(who),
        Object.values(sessionIds)
      );
      const expected = sorted(
        [...readable.keys()].map((id) => messageOf.get(id)!)
      );

      expect(expected.length).toBeGreaterThan(0);
      expect(sorted(await searchAs(who))).toEqual(expected);
    }
  );

  it.each(["outsider", "member", "participant", "holder", "admin", "dm"])(
    "finds for %s a message by its file name only in the sessions it can read",
    async (who) => {
      const readable = await readableSessions(
        callerOf(who),
        Object.values(sessionIds)
      );
      const expected = sorted(
        [...readable.keys()].map((id) => fileMessageOf.get(id)!)
      );

      const found = await searchAs(who, "zephyrledger");
      expect(expected.length).toBeGreaterThan(0);
      expect(sorted(found)).toEqual(expected);
      expect(found).not.toContain(foreignFileMessage);
    }
  );

  it("finds no DM message for an admin", async () => {
    const found = await searchAs("admin");

    expect(found).not.toContain(messageOf.get(sessionIds.dm));
    expect(found).not.toContain(messageOf.get(sessionIds.group));
    expect(await searchAs("dm")).toContain(messageOf.get(sessionIds.dm));
  });

  it("stops finding a members-only session's messages once its participant leaves", async () => {
    const f = s.fixtures;
    const space = await f.space({ org, visibility: "public" });
    const session = await f.session({ space, access: "members" });
    const leaver = await f.principal();
    await f.participant(session, leaver);
    const id = await s.insert(session, leaver.id, "departing words");
    const token = personToken({
      userId: leaver.tereoUserId!,
      org,
      perms: [READ],
    });
    const search = async () =>
      hitIds((await s.search(token, { q: "departing" })).body);
    expect(await search()).toEqual([id]);

    await prisma.sessionParticipant.update({
      where: {
        sessionId_userId: { sessionId: session.id, userId: leaver.id },
      },
      data: { leftAt: new Date() },
    });

    expect(await search()).toEqual([]);
  });

  it("never finds another organization's message with the same text", async () => {
    expect(await searchAs("admin")).not.toContain(foreignMessage);
    const elsewhere = personToken({ org: uuidv7(), perms: [ADMIN] });
    const res = await s.search(elsewhere, { q: "probe" });
    expect(hitIds(res.body)).not.toContain(foreignMessage);
    const byFile = await s.search(elsewhere, { q: "zephyrledger" });
    expect(hitIds(byFile.body)).not.toContain(foreignFileMessage);
  });
});
