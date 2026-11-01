// @module-tag int
// @module-tag events
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { getKind, invalidateKinds } from "../../utils/kinds.js";
import { spacePayload } from "../support/eventPayloads.js";
import { chatFixtures } from "../support/chatFixtures.js";
import type { ChangeEvent } from "../../utils/changes.js";
import { withChanges } from "../../utils/transaction.js";
import { changeBus } from "../../utils/changeBus.js";
import { prisma } from "../../utils/db/prisma.js";
import { logger } from "../../utils/logger.js";
import { v7 as uuidv7 } from "uuid";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fixtures = chatFixtures();
const organizationIds: string[] = [];

const spaceChange = (actorId: string) => {
  const organizationId = uuidv7();
  organizationIds.push(organizationId);
  const spaceId = uuidv7();
  return {
    type: "space.created" as const,
    organizationId,
    spaceId,
    actorId,
    entity: { type: "Space", id: spaceId },
    payload: spacePayload(spaceId),
  };
};

const rowsFor = async (organizationId: string) => ({
  events: await prisma.event.count({ where: { organizationId } }),
  outbox: (
    await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${organizationId}`
  )[0].n,
});

describe("withChanges", () => {
  beforeAll(async () => {
    await initializeTereo();
  });

  afterEach(() => {
    changeBus.removeAllListeners();
  });

  afterAll(async () => {
    await prisma.event.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    for (const id of organizationIds) {
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${id}`;
    }
    await fixtures.cleanup();
    await stopTereo();
  });

  it("emits committed events after commit, in order", async () => {
    const actor = await fixtures.principal();
    const first = spaceChange(actor.id);
    const second = spaceChange(actor.id);
    const seen: Array<{ events: ChangeEvent[]; committed: number }> = [];
    changeBus.on("committed", async (events: ChangeEvent[]) => {
      // A listener sees the rows: the transaction has committed.
      seen.push({
        events,
        committed: await prisma.event.count({
          where: { id: { in: events.map((e) => e.id) } },
        }),
      });
    });

    const result = await withChanges(async (_tx, record) => {
      await record(first);
      await record(second);
      return "done";
    });

    expect(result).toBe("done");
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0].events.map((e) => e.organizationId)).toEqual([
      first.organizationId,
      second.organizationId,
    ]);
    expect(seen[0].events[0].id < seen[0].events[1].id).toBe(true);
    expect(seen[0].committed).toBe(2);
  });

  it("emits nothing when it records nothing", async () => {
    let emitted = 0;
    changeBus.on("committed", () => emitted++);

    await withChanges(async () => undefined);

    expect(emitted).toBe(0);
  });

  it("emits nothing when fn throws", async () => {
    const actor = await fixtures.principal();
    const change = spaceChange(actor.id);
    let emitted = 0;
    changeBus.on("committed", () => emitted++);

    await expect(
      withChanges(async (_tx, record) => {
        await record(change);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(emitted).toBe(0);
    expect(await rowsFor(change.organizationId)).toEqual({
      events: 0,
      outbox: 0n,
    });
  });

  it("a listener that throws does not fail the request", async () => {
    const actor = await fixtures.principal();
    const change = spaceChange(actor.id);
    const logged: unknown[] = [];
    const original = logger.error.bind(logger);
    logger.error = ((obj: unknown, ...rest: unknown[]) => {
      logged.push(obj);
      return (original as (...a: unknown[]) => void)(obj, ...rest);
    }) as typeof logger.error;
    changeBus.on("committed", () => {
      throw new Error("listener failed");
    });

    try {
      const event = await withChanges((_tx, record) => record(change));

      expect(event.type).toBe("space.created");
      expect(await rowsFor(change.organizationId)).toMatchObject({ events: 1 });
      expect(logged).toEqual([
        expect.objectContaining({
          err: expect.objectContaining({ message: "listener failed" }),
        }),
      ]);
    } finally {
      logger.error = original;
    }
  });

  it("resolves with fn's result when a listener throws", async () => {
    const actor = await fixtures.principal();
    const change = spaceChange(actor.id);
    changeBus.on("committed", () => {
      throw new Error("listener failed");
    });

    const result = await withChanges(async (_tx, record) => {
      await record(change);
      return "fn result";
    });

    expect(result).toBe("fn result");
  });

  it("loads the kind cache before the transaction, so fn reads kinds without a query", async () => {
    invalidateKinds();
    const load = vi.spyOn(prisma.provisionedSpaceKind, "findMany");
    try {
      const queriesInside = await withChanges(async () => {
        const before = load.mock.calls.length;
        await getKind("default");
        return { before, after: load.mock.calls.length };
      });

      expect(queriesInside.before).toBe(1);
      expect(queriesInside.after).toBe(1);
    } finally {
      load.mockRestore();
    }
  });
});
