// @module-tag int
// @module-tag platform
import { pgErrorCodes } from "../../../utils/prismaErrors.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

// Rows are raw inserts: the constraints under test are the ones Prisma cannot
// express, and the client would refuse some of these inputs before Postgres.
const created: { table: string; id: string }[] = [];

// Tables whose rows are found by a column other than `id`.
const KEY_COLUMN: Record<string, string> = {
  space_join_requests: "space_id",
  message_mentions: "message_id",
};

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

const insertSpace = async (createdBy: string, organizationId = uuidv7()) => {
  const id = uuidv7();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "chat"."spaces" (id, organization_id, kind, name, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'team', 'Team', $3::uuid, NOW())`,
    id,
    organizationId,
    createdBy
  );
  created.push({ table: "spaces", id });
  return id;
};

const insertSession = (opts: {
  organizationId: string;
  spaceId?: string;
  type: "direct" | "group";
  directKey?: string;
  createdBy: string;
}) => {
  const id = uuidv7();
  created.push({ table: "sessions", id });
  return prisma.$executeRawUnsafe(
    `INSERT INTO "chat"."sessions" (id, organization_id, space_id, type, direct_key, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"chat"."session_type", $5, $6::uuid, NOW())`,
    id,
    opts.organizationId,
    opts.spaceId ?? null,
    opts.type,
    opts.directKey ?? null,
    opts.createdBy
  );
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
      `DELETE FROM "chat"."${table}" WHERE ${KEY_COLUMN[table] ?? "id"} = $1::uuid`,
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

  it("refuses a group session with a direct key", async () => {
    const user = await insertPrincipal("user", uuidv7());

    const codes = await codeOf(
      insertSession({
        organizationId: uuidv7(),
        type: "group",
        directKey: "a:b",
        createdBy: user,
      })
    );

    expect(codes).toContain("23514");
  });

  it("refuses a here mention with a user id", async () => {
    const user = await insertPrincipal("user", uuidv7());
    const org = uuidv7();
    const sessionId = uuidv7();
    created.push({ table: "sessions", id: sessionId });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "chat"."sessions" (id, organization_id, type, name, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'group', 'S', $3::uuid, NOW())`,
      sessionId,
      org,
      user
    );
    const messageId = uuidv7();
    created.push({ table: "messages", id: messageId });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "chat"."messages" (id, session_id, seq, sender_id, client_message_id)
       VALUES ($1::uuid, $2::uuid, 1, $3::uuid, 'c1')`,
      messageId,
      sessionId,
      user
    );
    created.push({ table: "message_mentions", id: messageId });

    const codes = await codeOf(
      prisma.$executeRawUnsafe(
        `INSERT INTO "chat"."message_mentions" (message_id, session_id, kind, user_id)
         VALUES ($1::uuid, $2::uuid, 'here', $3::uuid)`,
        messageId,
        sessionId,
        user
      )
    );

    expect(codes).toContain("23514");
  });

  it("refuses a session whose organization differs from its space's", async () => {
    const user = await insertPrincipal("user", uuidv7());
    const space = await insertSpace(user);

    const codes = await codeOf(
      insertSession({
        organizationId: uuidv7(),
        spaceId: space,
        type: "group",
        createdBy: user,
      })
    );

    expect(codes).toContain("23503");
  });

  it("refuses deleting a space that has a session", async () => {
    const user = await insertPrincipal("user", uuidv7());
    const org = uuidv7();
    const space = await insertSpace(user, org);
    await insertSession({
      organizationId: org,
      spaceId: space,
      type: "group",
      createdBy: user,
    });

    const codes = await codeOf(
      prisma.$executeRawUnsafe(
        `DELETE FROM "chat"."spaces" WHERE id = $1::uuid`,
        space
      )
    );

    // ON DELETE RESTRICT raises restrict_violation, not foreign_key_violation.
    expect(codes).toContain("23001");
  });
});
