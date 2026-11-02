// @module-tag int
// @module-tag provisioning
import { applyDocuments } from "../../../utils/provisioning/apply.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pgErrorCodes } from "../../../utils/prismaErrors.js";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";

const KIND = "race:held";

const wipe = async () => {
  await prisma.provisionedSpaceKind.deleteMany();
  await prisma.provisionedMessageType.deleteMany();
};

const declaring = [
  {
    file: "race.json",
    document: {
      version: "1.0.0",
      app: "race",
      spaceKinds: [
        {
          name: KIND,
          defaults: {
            visibility: "members",
            join: "invite",
            posting: "members",
          },
        },
      ],
    },
  },
] as Parameters<typeof applyDocuments>[0];

describe("applyDocuments races", () => {
  beforeEach(wipe);
  afterAll(wipe);

  it("gives up a held advisory lock on the server, with lock_timeout, before its own timeout", async () => {
    await applyDocuments(declaring);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await db.provisioned.holdShared(tx, "kind", KIND);
        held();
        await released;
      },
      { timeout: 20_000 }
    );
    await holding;

    try {
      // Retiring the kind waits for the shared hold.
      const failure = await applyDocuments([], { timeoutMs: 2_000 }).catch(
        (err: unknown) => err
      );
      expect(pgErrorCodes(failure)).toContain("55P03");
      const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      expect(waiting[0].n).toBe(0n);
    } finally {
      release();
      await holder;
    }
    expect(
      await prisma.provisionedSpaceKind.findUnique({ where: { name: KIND } })
    ).toMatchObject({ retiredAt: null });
  });
});
