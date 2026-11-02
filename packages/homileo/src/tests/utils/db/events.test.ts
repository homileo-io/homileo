// @module-tag int
// @module-tag events
import { Prisma } from "../../../../prisma/generated/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../support/chatFixtures.js";
import { db, prisma } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const organizationId = uuidv7();
const fixtures = chatFixtures();
const scope = Prisma.sql`organization_id = ${organizationId}::uuid`;

describe("readFrom's scan bound", () => {
  let ids: bigint[] = [];

  beforeAll(async () => {
    const actorId = (await fixtures.principal()).id;
    // Transaction ids far below any running one, so the horizon never holds them back.
    for (const tx of [1, 2, 3, 4, 5]) {
      await prisma.$executeRaw`
        INSERT INTO "chat"."events" (type, organization_id, actor_id, payload, tx_id)
        VALUES ('message.created', ${organizationId}::uuid, ${actorId}::uuid,
                ${JSON.stringify({ n: tx })}::jsonb, ${tx}::text::xid8)`;
    }
    ids = (
      await prisma.event.findMany({
        where: { organizationId },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).map((r) => r.id);
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { organizationId } });
    await fixtures.cleanup();
  });

  const start = () => ({ txId: 0n, id: 0n, at: new Date() });
  const only = (n: number) =>
    Prisma.sql`organization_id = ${organizationId}::uuid AND payload->>'n' = ${String(n)}`;

  it("stops a sparse read at maxScanned rows with hasMore and a cursor past them", async () => {
    const at = new Date(Date.now() - 60_000);
    const first = await db.events.readFrom({ ...start(), at }, only(4), 10, {
      scope,
      maxScanned: 2,
    });

    expect(first.rows).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.next).toEqual({ txId: 2n, id: ids[1], at });

    const second = await db.events.readFrom(first.next, only(4), 10, {
      scope,
      maxScanned: 2,
    });
    expect(second.rows.map((r) => r.id)).toEqual([ids[3]]);
    expect(second.hasMore).toBe(true);
    expect(second.next).toEqual({ txId: 4n, id: ids[3], at });

    const third = await db.events.readFrom(second.next, only(4), 10, {
      scope,
      maxScanned: 2,
    });
    expect(third.rows).toEqual([]);
    expect(third.hasMore).toBe(false);
  });

  it("returns every match once across pages cut by the bound", async () => {
    const seen: bigint[] = [];
    let next = start();
    for (let page = 0; page < 10; page++) {
      const read = await db.events.readFrom(next, scope, 2, {
        scope,
        maxScanned: 3,
      });
      seen.push(...read.rows.map((r) => r.id));
      next = read.next;
      if (!read.hasMore) break;
    }

    expect(seen).toEqual(ids);
  });
});

describe("db.events.insertMany", () => {
  const org = uuidv7();

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { organizationId: org } });
  });

  it("gives each input its own row, with ids ascending in input order", async () => {
    const actorId = uuidv7();
    const inputs = Array.from({ length: 40 }, (_, n) => ({
      type: "message.created",
      organizationId: org,
      spaceId: null,
      sessionId: null,
      actorId,
      payload: { n },
    }));

    const returned = await prisma.$transaction((tx) =>
      db.events.insertMany(tx, inputs)
    );

    const ids = returned.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));
    const rows = await prisma.event.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(returned.map((r) => byId.get(r.id)?.payload)).toEqual(
      inputs.map((i) => i.payload)
    );
    expect(returned.map((r) => r.createdAt)).toEqual(
      returned.map((r) => byId.get(r.id)?.createdAt)
    );
  });
});
