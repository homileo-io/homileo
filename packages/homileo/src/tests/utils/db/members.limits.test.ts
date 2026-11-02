// @module-tag int
// @module-tag spaces
import { planOf, queriesOf, SORTS } from "../../support/plans.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const MEMBERS = 3000;

const fixtures = chatFixtures();
const principalIds: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await prisma.principal.deleteMany({ where: { id: { in: principalIds } } });
});

describe("listPage", () => {
  it("seeks a deep page through the list index, without sorting", async () => {
    const space = await fixtures.space();
    const other = await fixtures.space();
    principalIds.push(...Array.from({ length: MEMBERS }, () => uuidv7()));
    await prisma.principal.createMany({
      data: principalIds.map((id) => ({
        id,
        kind: "user" as const,
        tereoUserId: uuidv7(),
      })),
    });
    const start = Date.UTC(2026, 0, 1);
    await prisma.spaceMember.createMany({
      data: principalIds.flatMap((userId, i) => [
        { spaceId: space.id, userId, joinedAt: new Date(start + i * 1000) },
        { spaceId: other.id, userId, joinedAt: new Date(start + i * 1000) },
      ]),
    });
    await prisma.$executeRaw`ANALYZE "chat"."space_members"`;

    const [query] = await queriesOf(
      () =>
        db.members.listPage(space.id, {
          after: {
            joinedAt: new Date(start + (MEMBERS / 2) * 1000),
            principalId: principalIds[MEMBERS / 2]!,
          },
          limit: 50,
        }),
      /FROM "chat"\."space_members"/
    );
    const plan = await planOf(query!);

    const seeks = plan.filter((n) =>
      /\bjoined_at >= /.test(n["Index Cond"] ?? "")
    );
    expect(seeks.map((n) => n["Index Name"])).toEqual([
      "space_members_space_id_joined_at_user_id_idx",
    ]);
    expect(plan.filter((n) => SORTS.includes(n["Node Type"]))).toEqual([]);
  });
});
