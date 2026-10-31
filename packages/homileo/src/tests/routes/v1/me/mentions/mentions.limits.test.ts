// @module-tag int
// @module-tag auth
// @module-tag sessions
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { seedMessages } from "../../../../support/unreadFixtures.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../../../../utils/db/index.js";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const seed = seedMessages();
const orgs: string[] = [];
const sessionIds: string[] = [];

afterAll(async () => {
  await seed.cleanup();
  await prisma.message.deleteMany({
    where: { sessionId: { in: sessionIds } },
  });
  await purgeOrganizations(orgs);
  await fixtures.cleanup();
});

const SESSIONS = 300;
const FILLER_MESSAGES = 2000;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

/** Every `Seq Scan` of `relation` anywhere in an EXPLAIN (FORMAT JSON) result. */
const seqScans = (plan: unknown, relation: string): PlanNode[] => {
  const walk = (n: PlanNode): PlanNode[] => [
    ...(n["Node Type"] === "Seq Scan" && n["Relation Name"] === relation
      ? [n]
      : []),
    ...(n.Plans ?? []).flatMap(walk),
  ];
  return (plan as Array<{ Plan: PlanNode }>).flatMap((p) => walk(p.Plan));
};

describe("mentions at scale", () => {
  it("reads only the caller's mentions, through an index", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const other = await fixtures.principal();

    const made: Awaited<ReturnType<typeof fixtures.session>>[] = [];
    for (let i = 0; i < SESSIONS; i += 25) {
      made.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, SESSIONS - i) }, () =>
            fixtures.session({ org })
          )
        ))
      );
    }
    sessionIds.push(...made.map((s) => s.id));
    await Promise.all(
      made.map((s) => fixtures.participant(s, { id: me.principalId }))
    );
    await Promise.all(made.map((s) => fixtures.participant(s, other)));
    // The caller left this one: a session mention there must not reach them.
    const left = await fixtures.session({ org });
    sessionIds.push(left.id);
    await fixtures.participant(left, { id: me.principalId }, "member", {
      left: true,
    });
    await fixtures.participant(left, other);

    await prisma.message.createMany({
      data: Array.from({ length: FILLER_MESSAGES }, (_, i) => ({
        sessionId: made[i % SESSIONS].id,
        // Above the seqs `seed.add` hands out, which count from 1.
        seq: 1000 + Math.floor(i / SESSIONS),
        senderId: other.id,
        clientMessageId: uuidv7(),
        type: "text",
        body: "filler",
        bodyText: "filler",
      })),
    });

    const own = await seed.add(made[0].id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });
    const here = await seed.add(made[1].id, other.id, {
      mentions: [{ kind: "here" }],
    });
    await seed.add(left.id, other.id, { mentions: [{ kind: "session" }] });

    const res = await fetchJson(
      "GET",
      `${env.PUBLIC_URL}/v1/me/mentions`,
      me.token
    );
    expect(res.status).toBe(200);
    const ids = res.body.data.map(
      (i: { message: { id: string } }) => i.message.id
    );
    expect(ids).toEqual([here.id, own.id]);

    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return db.mentions.explainList(tx, {
        organizationId: org,
        userId: me.principalId,
        before: null,
        limit: 21,
      });
    });
    expect(seqScans(plan, "messages")).toEqual([]);
    expect(JSON.stringify(plan)).toContain(
      "message_mentions_session_broadcast_idx"
    );
  });
});
