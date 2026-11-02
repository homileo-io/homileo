// @module-tag int
// @module-tag sessions
import { planOf, queriesOf, SORTS } from "../../support/plans.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const SESSIONS = 3000;

const fixtures = chatFixtures();

afterAll(() => fixtures.cleanup());

describe("list", () => {
  it("seeks a deep page of a space's sessions through the list index, without sorting", async () => {
    const org = uuidv7();
    const creator = await fixtures.principal();
    const space = await fixtures.space({ org, createdBy: creator });
    const other = await fixtures.space({ org, createdBy: creator });
    const start = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: SESSIONS }, (_, i) => ({
      id: uuidv7(),
      organizationId: org,
      type: "group" as const,
      createdBy: creator.id,
      createdAt: new Date(start + i * 1000),
      lastMessageAt: new Date(start + i * 2000),
    }));
    await prisma.session.createMany({
      data: rows.flatMap((row) => [
        { ...row, spaceId: space.id },
        { ...row, id: uuidv7(), spaceId: other.id },
      ]),
    });
    await prisma.$executeRaw`ANALYZE "chat"."sessions"`;
    const middle = rows[SESSIONS / 2]!;

    const [query] = await queriesOf(
      () =>
        db.sessions.list(prisma, {
          caller: {
            principalId: creator.id,
            tereoUserId: creator.tereoUserId!,
            isBot: false,
            permissions: [],
            isAdmin: false,
            organizationId: org,
          },
          scope: { spaceId: space.id, everything: true },
          includeArchived: false,
          after: middle,
          take: 51,
        }),
      /FROM "chat"\."sessions"/
    );
    const plan = await planOf(query!);

    const seeks = plan.filter((n) =>
      /\blast_message_at <= /.test(n["Index Cond"] ?? "")
    );
    expect(seeks.map((n) => n["Index Name"])).toEqual([
      "sessions_space_list_idx",
    ]);
    expect(plan.filter((n) => SORTS.includes(n["Node Type"]))).toEqual([]);
  });
});
