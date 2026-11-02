// @module-tag int
// @module-tag access
import type { Principal } from "../../../prisma/generated/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeKinds, provisionKind } from "../support/v1App.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { grantedKindsOf } from "../../utils/db/spaces.js";
import type { Caller } from "../../middleware/auth.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  readableSessions,
  readableSpace,
  readableSpaces,
} from "../../utils/access.js";
import {
  readableSessionWhere,
  readableSpaceWhere,
  readsEverySessionOf,
  spaceSessionsWhere,
} from "../../policy/index.js";

const fixtures = chatFixtures();
const org = uuidv7();
const GRANT = "sql-parity.cases.read";
const MODERATE = "sql-parity.queues.moderate";

const callerOf = (p: Principal, permissions: string[] = []): Caller => ({
  principalId: p.id,
  tereoUserId: p.tereoUserId ?? uuidv7(),
  isBot: false,
  permissions,
  isAdmin: permissions.includes("homileo.chat.admin"),
  organizationId: org,
});

type Name = "A" | "B" | "C" | "D";
type SessionName = `${Name}.${"space" | "members"}` | "group";

let spaceIds: Record<Name, string>;
let sessionIds: Record<SessionName, string>;
let callers: Record<string, Caller>;

// A: members-only, default kind. B: members-only, a kind granting GRANT read. C: public.
// D: members-only, a kind granting MODERATE moderate.
beforeAll(async () => {
  const kind = await provisionKind({
    grants: [{ permission: GRANT, access: "read" }],
  });
  const moderated = await provisionKind({
    grants: [{ permission: MODERATE, access: "moderate" }],
  });
  const spaces = {
    A: await fixtures.space({ org, visibility: "members" }),
    B: await fixtures.space({ org, kind, visibility: "members" }),
    C: await fixtures.space({ org, visibility: "public" }),
    D: await fixtures.space({ org, kind: moderated, visibility: "members" }),
  };
  spaceIds = {
    A: spaces.A.id,
    B: spaces.B.id,
    C: spaces.C.id,
    D: spaces.D.id,
  };
  const sessions = {} as Record<SessionName, { id: string }>;
  for (const name of ["A", "B", "C", "D"] as const) {
    for (const access of ["space", "members"] as const) {
      sessions[`${name}.${access}`] = await fixtures.session({
        space: spaces[name],
        access,
      });
    }
  }
  sessions.group = await fixtures.session({ org });
  sessionIds = Object.fromEntries(
    Object.entries(sessions).map(([k, v]) => [k, v.id])
  ) as Record<SessionName, string>;

  const p = async () => fixtures.principal();
  const [
    outsider,
    member,
    participant,
    left,
    holder,
    admin,
    bMember,
    moderator,
    writeHolder,
    adminHolder,
    parentAdmin,
    bareName,
  ] = await Promise.all(Array.from({ length: 12 }, p));
  await fixtures.member(spaces.A, member);
  await fixtures.participant(sessions["A.members"], member);
  await fixtures.participant(sessions["B.members"], participant);
  await fixtures.participant(sessions["C.members"], participant);
  await fixtures.participant(sessions.group, participant);
  await fixtures.participant(sessions.group, left, "member", { left: true });
  await fixtures.participant(sessions["C.members"], left, "member", {
    left: true,
  });
  await fixtures.member(spaces.B, bMember);
  callers = {
    outsider: callerOf(outsider),
    member: callerOf(member),
    participant: callerOf(participant),
    left: callerOf(left),
    holder: callerOf(holder, [GRANT]),
    admin: callerOf(admin, ["homileo.chat.admin"]),
    bMember: callerOf(bMember),
    moderator: callerOf(moderator, [MODERATE]),
    // Above GRANT on tereo's ladder: `x.write`, `x.admin`, and a parent's `admin`, which
    // covers MODERATE as well.
    writeHolder: callerOf(writeHolder, ["sql-parity.cases.write"]),
    adminHolder: callerOf(adminHolder, ["sql-parity.cases.admin"]),
    parentAdmin: callerOf(parentAdmin, ["sql-parity.admin"]),
    // Off the ladder: a bare `x` is not `x.read`.
    bareName: callerOf(bareName, ["sql-parity.cases"]),
  };
});

afterAll(async () => {
  await fixtures.cleanup();
  await removeKinds();
});

const sorted = (ids: Iterable<string>) => [...ids].sort();

const CASES = [
  ["outsider", ["C.space"], ["C"]],
  ["member", ["A.space", "A.members", "C.space"], ["A", "C"]],
  ["participant", ["C.space", "C.members", "group"], ["C"]],
  ["left", ["C.space"], ["C"]],
  ["holder", ["B.space", "B.members", "C.space"], ["B", "C"]],
  [
    "admin",
    [
      "A.space",
      "A.members",
      "B.space",
      "B.members",
      "C.space",
      "C.members",
      "D.space",
      "D.members",
    ],
    ["A", "B", "C", "D"],
  ],
  ["bMember", ["B.space", "C.space"], ["B", "C"]],
  ["moderator", ["C.space", "D.space", "D.members"], ["C", "D"]],
  ["writeHolder", ["B.space", "B.members", "C.space"], ["B", "C"]],
  ["adminHolder", ["B.space", "B.members", "C.space"], ["B", "C"]],
  [
    "parentAdmin",
    ["B.space", "B.members", "C.space", "D.space", "D.members"],
    ["B", "C", "D"],
  ],
  ["bareName", ["C.space"], ["C"]],
] as const;

describe("readableSessionWhere and readableSpaceWhere against the policy", () => {
  it.each(CASES)("%s", async (who, wantSessions, wantSpaces) => {
    const caller = callers[who];
    const granted = await grantedKindsOf(caller);
    const allSessions = Object.values(sessionIds);
    const allSpaces = Object.values(spaceIds);

    const bySql = await prisma.session.findMany({
      where: {
        organizationId: org,
        id: { in: allSessions },
        AND: [readableSessionWhere(caller, granted)],
      },
      select: { id: true },
    });
    const byPolicy = await readableSessions(caller, allSessions);
    const spacesBySql = await prisma.space.findMany({
      where: {
        organizationId: org,
        id: { in: allSpaces },
        AND: [readableSpaceWhere(caller, granted)],
      },
      select: { id: true },
    });
    const spacesByPolicy = await readableSpaces(caller, allSpaces);

    const expected = sorted(wantSessions.map((n) => sessionIds[n]));
    expect(sorted(bySql.map((r) => r.id))).toEqual(expected);
    expect(sorted(byPolicy.keys())).toEqual(expected);
    const expectedSpaces = sorted(wantSpaces.map((n) => spaceIds[n]));
    expect(sorted(spacesBySql.map((r) => r.id))).toEqual(expectedSpaces);
    expect(sorted(spacesByPolicy.keys())).toEqual(expectedSpaces);
  });
});

describe("spaceSessionsWhere against the policy", () => {
  it.each(CASES)(
    "%s, in each space it can read",
    async (who, wantSessions, wantSpaces) => {
      const caller = callers[who];
      for (const space of wantSpaces) {
        const { facts } = await readableSpace(caller, spaceIds[space]);
        const bySql = await prisma.session.findMany({
          where: {
            organizationId: org,
            AND: [
              spaceSessionsWhere(
                caller,
                spaceIds[space],
                readsEverySessionOf(caller, facts)
              ),
            ],
          },
          select: { id: true },
        });
        const inSpace = (Object.keys(sessionIds) as SessionName[]).filter((n) =>
          n.startsWith(`${space}.`)
        );
        const byPolicy = await readableSessions(
          caller,
          inSpace.map((n) => sessionIds[n])
        );

        const expected = sorted(
          wantSessions
            .filter((n) => n.startsWith(`${space}.`))
            .map((n) => sessionIds[n as SessionName])
        );
        expect(sorted(bySql.map((r) => r.id)), space).toEqual(expected);
        expect(sorted(byPolicy.keys()), space).toEqual(expected);
      }
    }
  );
});
