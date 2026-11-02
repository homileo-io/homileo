// @module-tag int
// @module-tag auth
// @module-tag race
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const user = (tereoUserId: string) => ({
  tereoUserId,
  isBot: false,
  displayName: null,
});

describe("db.principals.findOrCreateMany", () => {
  it("inserts in id order, so overlapping first sightings given in opposite orders do not deadlock", async () => {
    const [low, high] = [uuidv7(), uuidv7()].sort();

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));

    // Inserts low, waits, then high: id order.
    const first = prisma.$transaction(async (tx) => {
      await db.principals.findOrCreateMany([user(low)], tx);
      held();
      await hold;
      await db.principals.findOrCreateMany([user(high)], tx);
    });
    await holding;

    const second = db.principals.findOrCreateMany([user(high), user(low)]);
    await new Promise((r) => setTimeout(r, 200));
    release();

    await first;
    const rows = await second;
    expect(rows.map((r) => r.tereoUserId)).toEqual([high, low]);
  });
});
