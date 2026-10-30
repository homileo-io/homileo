// @module-tag int
// @module-tag platform
import { pgErrorCodes } from "../../../utils/prismaErrors.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

// Rows are raw inserts: the constraints under test are the ones Prisma cannot
// express, and the client would refuse some of these inputs before Postgres.
const created: { table: string; id: string }[] = [];

const insertPrincipal = async (kind: "user" | "external", userId?: string) => {
  const id = uuidv7();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "chat"."principals" (id, kind, tereo_user_id, updated_at)
     VALUES ($1::uuid, $2::"chat"."principal_kind", $3::uuid, NOW())`,
    id,
    kind,
    userId ?? null
  );
  created.push({ table: "principals", id });
  return id;
};

const insertSpace = async (createdBy: string) => {
  const id = uuidv7();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "chat"."spaces" (id, organization_id, kind, name, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'team', 'Team', $3::uuid, NOW())`,
    id,
    uuidv7(),
    createdBy
  );
  created.push({ table: "spaces", id });
  return id;
};

const codeOf = async (run: Promise<unknown>): Promise<string[]> => {
  try {
    await run;
  } catch (err) {
    return pgErrorCodes(err);
  }
  return [];
};

afterAll(async () => {
  for (const { table, id } of created.reverse()) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "chat"."${table}" WHERE ${
        table === "space_join_requests" ? "space_id" : "id"
      } = $1::uuid`,
      id
    );
  }
});

describe("baseline schema", () => {
  it("refuses a user principal without a tereo user id", async () => {
    const codes = await codeOf(insertPrincipal("user"));

    expect(codes).toContain("23514");
  });

  it("refuses two pending join requests for one user", async () => {
    const user = await insertPrincipal("user", uuidv7());
    const space = await insertSpace(user);
    const insertRequest = () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "chat"."space_join_requests" (id, space_id, user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        uuidv7(),
        space,
        user
      );
    created.push({ table: "space_join_requests", id: space });
    await insertRequest();

    const codes = await codeOf(insertRequest());

    expect(codes).toContain("23505");
  });

  it("refuses a direct session inside a space", async () => {
    const user = await insertPrincipal("user", uuidv7());
    const space = await insertSpace(user);

    const codes = await codeOf(
      prisma.$executeRawUnsafe(
        `INSERT INTO "chat"."sessions" (id, organization_id, space_id, type, direct_key, created_by, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'direct', 'a:b', $4::uuid, NOW())`,
        uuidv7(),
        uuidv7(),
        space,
        user
      )
    );

    expect(codes).toContain("23514");
  });

  it("refuses an events row with no partition for its day", async () => {
    const codes = await codeOf(
      prisma.$executeRawUnsafe(
        `INSERT INTO "chat"."events" (created_at, type, organization_id, payload)
         VALUES (NOW() + INTERVAL '30 days', 'message.created', $1::uuid, '{}')`,
        uuidv7()
      )
    );

    expect(codes).toContain("23514");
  });
});
