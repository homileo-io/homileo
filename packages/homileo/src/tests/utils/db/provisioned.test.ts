// @module-tag int
// @module-tag provisioning
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { outboxTableSql } from "@tereo-io/sdk";
import env from "../../../env.js";
import { Client } from "pg";

const fixtures = chatFixtures();

describe("messageUses", () => {
  afterAll(() => fixtures.cleanup());

  it("tells whether a message uses the type", async () => {
    await fixtures.message("plan-test:used");

    const uses = (type: string) =>
      prisma.$transaction((tx) => db.provisioned.messageUses(tx, type));
    expect(await uses("plan-test:used")).toBe(true);
    expect(await uses("plan-test:unused")).toBe(false);
  });

  it("is an index probe on messages_type_idx, even with a generic plan", async () => {
    // The statement messageUses runs.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN SELECT 1 FROM "chat"."messages"
        WHERE type = ${"plan-test:unused"} AND type <> 'text'
        LIMIT 1`;
    });

    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(
      /Index Only Scan using messages_type_idx/
    );
  });
});

describe("hasUnarchivedSpaces", () => {
  it("is an index probe on spaces_kind_unarchived_idx, even with a generic plan", async () => {
    // The statement hasUnarchivedSpaces runs.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ "QUERY PLAN": string }>>`
        EXPLAIN SELECT 1 FROM "chat"."spaces"
        WHERE kind = ${"plan-test:kind"} AND archived_at IS NULL
        LIMIT 1`;
    });

    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(
      /Index (Only )?Scan using spaces_kind_unarchived_idx/
    );
  });
});

describe("holdShared", () => {
  it("writes no row lock: the provisioned row stays free to lock", async () => {
    const name = "plan-test:held";
    await prisma.provisionedMessageType.upsert({
      where: { name },
      create: {
        name,
        app: "plan-test",
        payloadSchema: {},
        documentVersion: "1",
        sourceFile: "plan-test.json",
      },
      update: {},
    });
    const other = new Client({ connectionString: env.DATABASE_URL });
    await other.connect();
    try {
      await prisma.$transaction(async (tx) => {
        await db.provisioned.holdShared(tx, "message_type", name);

        await expect(
          other.query(
            `SELECT name FROM "chat"."provisioned_message_types"
             WHERE name = $1 FOR UPDATE NOWAIT`,
            [name]
          )
        ).resolves.toMatchObject({ rowCount: 1 });
      });
    } finally {
      await other.end();
      await prisma.provisionedMessageType.delete({ where: { name } });
    }
  });
});

describe("core_outbox", () => {
  it("has @tereo-io/sdk's pending index, predicate included", async () => {
    const [row] = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT indexdef AS def FROM pg_indexes
      WHERE schemaname = 'core' AND indexname = 'core_outbox_pending_idx'`;

    expect(row?.def).toMatch(
      /\(next_attempt_at\) WHERE \(dead_lettered_at IS NULL\)$/
    );
    expect(outboxTableSql("core.core_outbox")).toMatch(
      /"core_outbox_pending_idx" ON .* \("next_attempt_at"\) WHERE "dead_lettered_at" IS NULL;/
    );
  });
});
