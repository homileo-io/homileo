// @module-tag int
// @module-tag events
// @module-tag race
import { Prisma } from "../../../../prisma/generated/client/index.js";
import { ensureEventPartitions } from "../../../utils/partitions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../support/chatFixtures.js";
import { db, prisma } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

const organizationId = uuidv7();
const fixtures = chatFixtures();
let actorId = "";
const mine = Prisma.sql`organization_id = ${organizationId}::uuid`;

const input = (n: number) => ({
  type: "message.created",
  organizationId,
  spaceId: null,
  sessionId: null,
  actorId,
  payload: { n },
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe("event positions", () => {
  beforeAll(async () => {
    await ensureEventPartitions();
    actorId = (await fixtures.principal()).id;
  });
  afterAll(async () => {
    await prisma.event.deleteMany({ where: { organizationId } });
    await fixtures.cleanup();
  });

  it("holds back an event that committed ahead of an older open transaction", async () => {
    const before = await db.events.head();
    const aInserted = deferred();
    const commitA = deferred();
    let aRow!: { id: bigint };
    let bRow!: { id: bigint };

    // A takes the lower transaction id and stays open on its own connection.
    const a = prisma.$transaction(
      async (tx) => {
        aRow = await db.events.insert(tx, input(1));
        aInserted.resolve();
        await commitA.promise;
      },
      { timeout: 30_000 }
    );
    try {
      await aInserted.promise;
      await prisma.$transaction(async (tx) => {
        bRow = await db.events.insert(tx, input(2));
      });
      expect(bRow.id).toBeGreaterThan(aRow.id);

      const held = await db.events.readFrom(before, mine, 10);

      expect(held.rows).toEqual([]);
      expect(held.hasMore).toBe(false);
      expect(held.next.txId).toBe(before.txId);
      expect(held.next.id).toBe(before.id);

      commitA.resolve();
      await a;

      const released = await db.events.readFrom(before, mine, 10);
      expect(released.rows.map((r) => r.id)).toEqual([aRow.id, bRow.id]);
      expect(released.rows[0].txId).toBeLessThan(released.rows[1].txId);
      expect(released.hasMore).toBe(false);
      expect(released.next.id).toBe(bRow.id);
      expect(released.next.txId).toBe(released.rows[1].txId);

      const after = await db.events.readFrom(released.next, mine, 10);
      expect(after.rows).toEqual([]);
      expect(after.next.txId).toBe(released.next.txId);
      expect(after.next.id).toBe(released.next.id);
    } finally {
      commitA.resolve();
      await a.catch(() => {});
    }
  });

  it("orders by (tx_id, id) within a transaction, pages with hasMore, and reports the database's time", async () => {
    const start = await db.events.head();
    const rows = await prisma.$transaction(async (tx) => [
      await db.events.insert(tx, input(1)),
      await db.events.insert(tx, input(2)),
      await db.events.insert(tx, input(3)),
    ]);

    const first = await db.events.readFrom(start, mine, 2);
    expect(first.rows.map((r) => r.id)).toEqual([rows[0].id, rows[1].id]);
    expect(first.hasMore).toBe(true);
    expect(first.rows[0]).toMatchObject({
      type: "message.created",
      organizationId,
      payload: { n: 1 },
    });
    expect(first.rows[0].txId).toBe(first.rows[1].txId);

    const second = await db.events.readFrom(first.next, mine, 2);
    expect(second.rows.map((r) => r.id)).toEqual([rows[2].id]);
    expect(second.hasMore).toBe(false);
    expect(Math.abs(second.next.at.getTime() - Date.now())).toBeLessThan(
      60_000
    );
  });

  it("keeps the cursor's time while pages remain and refreshes it on the last", async () => {
    const start = await db.events.head();
    const old = { ...start, at: new Date(start.at.getTime() - 3_600_000) };
    await prisma.$transaction(async (tx) => {
      await db.events.insert(tx, input(1));
      await db.events.insert(tx, input(2));
    });

    const first = await db.events.readFrom(old, mine, 1);
    const last = await db.events.readFrom(first.next, mine, 1);

    expect(first.hasMore).toBe(true);
    expect(first.next.at).toEqual(old.at);
    expect(last.hasMore).toBe(false);
    expect(last.next.at.getTime()).toBeGreaterThan(
      old.at.getTime() + 3_000_000
    );
  });

  it("returns a head whose id is zero", async () => {
    const head = await db.events.head();

    expect(head.id).toBe(0n);
    expect(head.txId).toBeGreaterThan(0n);
    expect(Math.abs(head.at.getTime() - Date.now())).toBeLessThan(60_000);
  });
});
