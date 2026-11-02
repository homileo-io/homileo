// @module-tag int
// @module-tag sessions
import { planOf, queriesOf, SORTS } from "../../support/plans.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const PARTICIPANTS = 3000;

const fixtures = chatFixtures();
const principalIds: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await prisma.principal.deleteMany({ where: { id: { in: principalIds } } });
});

describe("listCurrent", () => {
  it("seeks a deep page through the current-participants index, without sorting", async () => {
    const session = await fixtures.session();
    const other = await fixtures.session();
    principalIds.push(...Array.from({ length: PARTICIPANTS }, () => uuidv7()));
    await prisma.principal.createMany({
      data: principalIds.map((id) => ({
        id,
        kind: "user" as const,
        tereoUserId: uuidv7(),
      })),
    });
    const start = Date.UTC(2026, 0, 1);
    await prisma.sessionParticipant.createMany({
      data: principalIds.flatMap((userId, i) => [
        { sessionId: session.id, userId, joinedAt: new Date(start + i * 1000) },
        { sessionId: other.id, userId, joinedAt: new Date(start + i * 1000) },
      ]),
    });
    await prisma.$executeRaw`ANALYZE "chat"."session_participants"`;

    const [query] = await queriesOf(
      () =>
        db.participants.listCurrent(
          prisma,
          session.id,
          {
            joinedAt: new Date(start + (PARTICIPANTS / 2) * 1000),
            principalId: principalIds[PARTICIPANTS / 2]!,
          },
          51
        ),
      /FROM "chat"\."session_participants"/
    );
    const plan = await planOf(query!);

    const seeks = plan.filter((n) =>
      /\bjoined_at >= /.test(n["Index Cond"] ?? "")
    );
    expect(seeks.map((n) => n["Index Name"])).toEqual([
      "session_participants_current_idx",
    ]);
    expect(plan.filter((n) => SORTS.includes(n["Node Type"]))).toEqual([]);
  });
});
