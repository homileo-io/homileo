// @module-tag int
// @module-tag sessions
// @module-tag race
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const org = uuidv7();
const url = (s: string, p: string) =>
  `${env.PUBLIC_URL}/v1/sessions/${s}/participants/${p}`;

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

// A backend blocked by `blocker` itself, on a space_members statement: the
// join, waiting on the uncommitted insert, and not some other lock wait.
const waitForBlockedBy = async (blocker: number): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND ${blocker}::int = ANY (pg_blocking_pids(pid))
        AND query LIKE '%space_members%'`;
    if (waiting > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The join never waited on the membership insert");
};

describe("PUT /v1/sessions/:sessionId/participants/:principalId races", () => {
  it("joins when a parallel join of another session of the space inserts the membership first", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);

    let join: Promise<{ status: number }> | undefined;
    await prisma.$transaction(
      async (tx) => {
        // The other join: its membership is inserted but not yet committed.
        await tx.spaceMember.create({
          data: { spaceId: space.id, userId: me.principalId, role: "member" },
        });
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS pid`;
        join = fetchJson("PUT", url(s.id, me.principalId), me.token);
        await waitForBlockedBy(pid);
      },
      { timeout: 20_000 }
    );

    expect((await join!).status).toBe(201);
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, userId: me.principalId },
      })
    ).toBe(1);
    expect(
      await prisma.event.count({
        where: { spaceId: space.id, type: "space.member_added" },
      })
    ).toBe(0);
    expect(
      await prisma.sessionParticipant.count({
        where: { sessionId: s.id, userId: me.principalId, leftAt: null },
      })
    ).toBe(1);
  });
});
