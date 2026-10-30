// @module-tag int
// @module-tag sessions
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../support/chatFixtures.js";
import { withChanges } from "../../../utils/transaction.js";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

beforeAll(async () => {
  await initializeTereo();
});

afterAll(async () => {
  await prisma.event.deleteMany({ where: { organizationId: org } });
  await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${org}`;
  await fixtures.cleanup();
  await stopTereo();
});

const add = (
  session: Awaited<ReturnType<typeof fixtures.session>>,
  actorId: string,
  ids: string[],
  role: "owner" | "member" = "member"
) =>
  withChanges((tx, record) =>
    db.sessions.addParticipants(tx, record, session, ids, role, actorId)
  );

const added = (sessionId: string) =>
  prisma.event.findMany({
    where: { sessionId, type: "session.participant_added" },
    orderBy: { id: "asc" },
  });

describe("db.sessions.addParticipants", () => {
  it("inserts new participants and records one event for each", async () => {
    const actor = await fixtures.principal();
    const a = await fixtures.principal();
    const b = await fixtures.principal();
    const session = await fixtures.session({ org, createdBy: actor });

    const rows = await add(session, actor.id, [a.id, b.id]);

    expect(rows.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.role === "member")).toBe(true);
    const events = await added(session.id);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actorId: actor.id, organizationId: org });
  });

  it("skips current participants and records nothing for them", async () => {
    const actor = await fixtures.principal();
    const a = await fixtures.principal();
    const session = await fixtures.session({ org, createdBy: actor });
    await fixtures.participant(session, a, "owner");

    const rows = await add(session, actor.id, [a.id]);

    expect(rows).toEqual([]);
    expect(await added(session.id)).toEqual([]);
    const row = await prisma.sessionParticipant.findFirstOrThrow({
      where: { sessionId: session.id, userId: a.id },
    });
    expect(row.role).toBe("owner");
  });

  it("re-joins a participant who left, keeping their read position", async () => {
    const actor = await fixtures.principal();
    const a = await fixtures.principal();
    const session = await fixtures.session({ org, createdBy: actor });
    await fixtures.participant(session, a, "member", { left: true });
    const joinedBefore = new Date(Date.now() - 86_400_000);
    await prisma.sessionParticipant.update({
      where: { sessionId_userId: { sessionId: session.id, userId: a.id } },
      data: { lastReadSeq: 7, joinedAt: joinedBefore },
    });

    const rows = await add(session, actor.id, [a.id]);

    expect(rows).toHaveLength(1);
    expect(rows[0].leftAt).toBeNull();
    expect(rows[0].lastReadSeq).toBe(7n);
    expect(rows[0].joinedAt.getTime()).toBeGreaterThan(joinedBefore.getTime());
    expect(await added(session.id)).toHaveLength(1);
  });

  it("records the participant in the event payload", async () => {
    const actor = await fixtures.principal();
    const a = await fixtures.principal();
    const session = await fixtures.session({ org, createdBy: actor });

    await add(session, actor.id, [a.id], "owner");

    const [event] = await added(session.id);
    expect(event.payload).toMatchObject({
      sessionId: session.id,
      participant: { principalId: a.id, role: "owner", lastReadSeq: 0 },
    });
  });
});
