// @module-tag int
// @module-tag search
// @module-tag job
import { processSearchTextRebuild } from "../../jobs/searchTextRebuild.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { removeKinds, provisionKind } from "../support/v1App.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { prisma } from "../../utils/db/prisma.js";

const fixtures = chatFixtures();
const HOUR_MS = 60 * 60 * 1000;

const stampKind = (name: string, changedAt: Date, builtAt: Date | null) =>
  prisma.provisionedSpaceKind.update({
    where: { name },
    data: { searchChangedAt: changedAt, searchBuiltAt: builtAt },
  });

/** Three spaces of the kind, two sessions each, every search_text the name alone. */
const seed = async (kind: string) => {
  const spaces = [];
  for (let i = 0; i < 3; i++) {
    const space = await fixtures.space({ kind, name: `Case ${i}` });
    await prisma.space.update({
      where: { id: space.id },
      data: { metadata: { customerName: `Acme ${i}`, other: "x" } },
    });
    const sessions = [];
    for (let j = 0; j < 2; j++) {
      const s = await fixtures.session({ space });
      await prisma.session.update({
        where: { id: s.id },
        data: {
          name: `Chat ${i}-${j}`,
          metadata: { customerName: `Beta ${i}` },
        },
      });
      sessions.push(s.id);
    }
    spaces.push({ id: space.id, sessions });
  }
  await prisma.$executeRaw`
    UPDATE "chat"."spaces" SET search_text = name WHERE kind = ${kind}`;
  await prisma.$executeRaw`
    UPDATE "chat"."sessions" SET search_text = name
    WHERE space_id IN (SELECT id FROM "chat"."spaces" WHERE kind = ${kind})`;
  return spaces;
};

const texts = async (kind: string) => ({
  spaces: await prisma.$queryRaw<
    Array<{ name: string; search_text: string }>
  >`SELECT name, search_text FROM "chat"."spaces" WHERE kind = ${kind} ORDER BY name`,
  sessions: await prisma.$queryRaw<
    Array<{ name: string; search_text: string }>
  >`SELECT s.name, s.search_text FROM "chat"."sessions" s
    JOIN "chat"."spaces" p ON p.id = s.space_id
    WHERE p.kind = ${kind} ORDER BY s.name`,
});

describe("processSearchTextRebuild", () => {
  beforeEach(async () => {
    await fixtures.cleanup();
    await removeKinds();
  });
  afterAll(async () => {
    await fixtures.cleanup();
    await removeKinds();
  });

  it("rebuilds every space and session of a changed kind in batches", async () => {
    const kind = await provisionKind({
      search: { metadata: ["customerName"] },
    });
    await seed(kind);
    const changedAt = new Date(Date.now() - HOUR_MS);
    await stampKind(kind, changedAt, null);
    const before = await prisma.space.findMany({
      where: { kind },
      select: { id: true, updatedAt: true },
    });

    const result = await processSearchTextRebuild({
      batchSize: 2,
      settleMs: 0,
    });

    expect(result.kinds).toContain(kind);
    expect(result.rows).toBeGreaterThanOrEqual(9);
    const after = await texts(kind);
    expect(after.spaces.map((r) => r.search_text)).toEqual([
      "Case 0 Acme 0",
      "Case 1 Acme 1",
      "Case 2 Acme 2",
    ]);
    expect(after.sessions.map((r) => r.search_text)).toEqual([
      "Chat 0-0 Beta 0",
      "Chat 0-1 Beta 0",
      "Chat 1-0 Beta 1",
      "Chat 1-1 Beta 1",
      "Chat 2-0 Beta 2",
      "Chat 2-1 Beta 2",
    ]);
    const row = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: kind },
    });
    expect(row.searchBuiltAt).toEqual(changedAt);
    const afterRows = await prisma.space.findMany({
      where: { kind },
      select: { id: true, updatedAt: true },
    });
    expect(afterRows).toEqual(before);
  });

  it("leaves spaces of kinds that are not stamped alone", async () => {
    const kind = await provisionKind({
      search: { metadata: ["customerName"] },
    });
    const untouched = await provisionKind({
      search: { metadata: ["customerName"] },
    });
    await seed(kind);
    await seed(untouched);
    await stampKind(kind, new Date(Date.now() - HOUR_MS), null);
    const before = await texts(untouched);

    await processSearchTextRebuild({ batchSize: 2, settleMs: 0 });

    expect(await texts(untouched)).toEqual(before);
  });

  it("skips a kind stamped within the settle time", async () => {
    const kind = await provisionKind({
      search: { metadata: ["customerName"] },
    });
    await seed(kind);
    await stampKind(kind, new Date(), null);
    const before = await texts(kind);

    const result = await processSearchTextRebuild({ settleMs: 60_000 });

    expect(result.kinds).not.toContain(kind);
    expect(await texts(kind)).toEqual(before);
  });

  it("rebuilds again when the stamp has moved since the last build", async () => {
    const kind = await provisionKind({
      search: { metadata: ["customerName"] },
    });
    await seed(kind);
    await stampKind(kind, new Date(Date.now() - 2 * HOUR_MS), null);
    await processSearchTextRebuild({ settleMs: 0 });
    expect(
      (await processSearchTextRebuild({ settleMs: 0 })).kinds
    ).not.toContain(kind);

    await prisma.provisionedSpaceKind.update({
      where: { name: kind },
      data: {
        definition: {
          ...((
            await prisma.provisionedSpaceKind.findUniqueOrThrow({
              where: { name: kind },
            })
          ).definition as object),
          search: { metadata: ["other"] },
        },
        searchChangedAt: new Date(Date.now() - HOUR_MS),
      },
    });
    const result = await processSearchTextRebuild({ settleMs: 0 });

    expect(result.kinds).toContain(kind);
    const after = await texts(kind);
    expect(after.spaces[0].search_text).toBe("Case 0 x");
    const row = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: kind },
    });
    expect(row.searchBuiltAt).toEqual(row.searchChangedAt);
  });
});
