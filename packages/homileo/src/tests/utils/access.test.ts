// @module-tag int
// @module-tag access
import type { Principal } from "../../../prisma/generated/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../support/chatFixtures.js";
import { invalidateKinds } from "../../utils/kinds.js";
import type { Caller } from "../../middleware/auth.js";
import { NotFoundError } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  readableMessage,
  readableSession,
  readableSpace,
  readableSpaces,
} from "../../utils/access.js";

const fixtures = chatFixtures();
const kindNames: string[] = [];

const callerOf = (
  p: Principal,
  org: string,
  permissions: string[] = []
): Caller => ({
  principalId: p.id,
  tereoUserId: p.tereoUserId ?? uuidv7(),
  isBot: p.isBot,
  permissions,
  isAdmin: permissions.includes("homileo.chat.admin"),
  organizationId: org,
});

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
};

const definition = (name: string) => ({
  name,
  defaults: { visibility: "members", join: "invite", posting: "members" },
  overridable: [],
  states: [],
  grants: [{ permission: `${name}.read`, access: "read" }],
  bots: [],
  editWindowSeconds: null,
  search: { metadata: [] },
});

const kindRow = async (retired = false) => {
  const name = `access-test:${uuidv7().slice(-12)}`;
  kindNames.push(name);
  await prisma.provisionedSpaceKind.create({
    data: {
      name,
      app: "access-test",
      definition: definition(name),
      documentVersion: "1.0.0",
      sourceFile: "access.json",
      retiredAt: retired ? new Date() : null,
    },
  });
  invalidateKinds();
  return name;
};

describe("access loading", () => {
  beforeAll(() => invalidateKinds());

  afterAll(async () => {
    await fixtures.cleanup();
    await prisma.provisionedSpaceKind.deleteMany({
      where: { name: { in: kindNames } },
    });
  });

  it("returns 404 for a space in another organization even to an admin", async () => {
    const space = await fixtures.space({ visibility: "public" });
    const admin = await fixtures.principal();
    const caller = callerOf(admin, uuidv7(), ["homileo.chat.admin"]);

    const err = await caught(readableSpace(caller, space.id));

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("returns a space the caller is a member of, with the role in its facts", async () => {
    const space = await fixtures.space({});
    const who = await fixtures.principal();
    await fixtures.member(space, who, "moderator");

    const { facts, space: row } = await readableSpace(
      callerOf(who, space.organizationId),
      space.id
    );

    expect(row.id).toBe(space.id);
    expect(facts).toMatchObject({
      organizationId: space.organizationId,
      role: "moderator",
      archived: false,
      visibility: "members",
    });
    expect(facts.kind.name).toBe("default");
  });

  it("treats a participant who left as not a participant", async () => {
    const space = await fixtures.space({ visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const who = await fixtures.principal();
    await fixtures.participant(session, who, "member", { left: true });

    const ctx = await readableSession(
      callerOf(who, space.organizationId),
      session.id
    );

    expect(ctx.participant).toBeNull();
    expect(ctx.facts.participantRole).toBeNull();
  });

  it("returns 404 for a left participant of a space-less group", async () => {
    const session = await fixtures.session({ type: "group" });
    const who = await fixtures.principal();
    await fixtures.participant(session, who, "member", { left: true });

    const err = await caught(
      readableSession(callerOf(who, session.organizationId), session.id)
    );

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("builds the facts of a space whose kind was retired", async () => {
    const name = await kindRow(true);
    const space = await fixtures.space({ kind: name });
    const who = await fixtures.principal();
    await fixtures.member(space, who);

    const { facts } = await readableSpace(
      callerOf(who, space.organizationId),
      space.id
    );

    expect(facts.kind.name).toBe(name);
    expect(facts.kind.grants).toHaveLength(1);
  });

  it("falls back to the built-in kind when the kind row is gone", async () => {
    const space = await fixtures.space({ kind: "gone:kind" });
    const who = await fixtures.principal();
    await fixtures.member(space, who);

    const { facts } = await readableSpace(
      callerOf(who, space.organizationId),
      space.id
    );

    expect(facts.kind.name).toBe("default");
  });

  it("returns 404 for an unreadable session and for a missing one alike", async () => {
    const session = await fixtures.session({ type: "group" });
    const outsider = await fixtures.principal();
    const caller = callerOf(outsider, session.organizationId);

    const unreadable = (await caught(
      readableSession(caller, session.id)
    )) as NotFoundError;
    const missing = (await caught(
      readableSession(caller, uuidv7())
    )) as NotFoundError;

    expect(unreadable).toBeInstanceOf(NotFoundError);
    expect(unreadable.statusCode).toBe(404);
    expect({ code: unreadable.code, message: unreadable.message }).toEqual({
      code: missing.code,
      message: missing.message,
    });
  });

  it("loads a message with its session context", async () => {
    const session = await fixtures.session({ type: "group" });
    const who = await fixtures.principal();
    await fixtures.participant(session, who, "owner");
    const message = await prisma.message.create({
      data: {
        sessionId: session.id,
        seq: 1,
        senderId: who.id,
        clientMessageId: uuidv7(),
        body: "hi",
      },
    });

    const ctx = await readableMessage(
      callerOf(who, session.organizationId),
      message.id
    );

    expect(ctx.message.id).toBe(message.id);
    expect(ctx.session.id).toBe(session.id);
    expect(ctx.facts.participantRole).toBe("owner");
    expect(ctx.participant?.userId).toBe(who.id);
  });

  it("returns 404 for a message in an unreadable session", async () => {
    const session = await fixtures.session({ type: "group" });
    const sender = await fixtures.principal();
    const outsider = await fixtures.principal();
    const message = await prisma.message.create({
      data: {
        sessionId: session.id,
        seq: 1,
        senderId: sender.id,
        clientMessageId: uuidv7(),
        body: "hi",
      },
    });

    const err = await caught(
      readableMessage(callerOf(outsider, session.organizationId), message.id)
    );

    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("locks the session row for the transaction when asked", async () => {
    const session = await fixtures.session({ type: "group" });
    const who = await fixtures.principal();
    await fixtures.participant(session, who, "owner");
    const caller = callerOf(who, session.organizationId);
    let blocked = true;

    await prisma.$transaction(async (tx) => {
      await readableSession(caller, session.id, { tx, lock: true });
      const other = prisma
        .$transaction(async (tx2) => {
          await tx2.$queryRaw`SELECT id FROM "chat"."sessions" WHERE id = ${session.id}::uuid FOR UPDATE NOWAIT`;
        })
        .then(
          () => (blocked = false),
          () => (blocked = true)
        );
      await other;
    });

    expect(blocked).toBe(true);
  });

  it("requires a transaction to lock", async () => {
    const session = await fixtures.session({ type: "group" });
    const who = await fixtures.principal();
    await fixtures.participant(session, who);

    await expect(
      readableSession(callerOf(who, session.organizationId), session.id, {
        lock: true,
      })
    ).rejects.toThrow(/transaction/);
  });
});

describe("readableSpaces", () => {
  afterAll(async () => {
    await fixtures.cleanup();
    await prisma.provisionedSpaceKind.deleteMany({
      where: { name: { in: kindNames } },
    });
  });

  it("returns the spaces the caller can read now, in their organization", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const member = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(member, who);
    const open = await fixtures.space({ org, visibility: "public" });
    const hidden = await fixtures.space({ org, visibility: "members" });
    const granted = await fixtures.space({ org, kind: await kindRow() });
    const foreign = await fixtures.space({ visibility: "public" });
    await fixtures.member(foreign, who);

    const readable = await readableSpaces(
      callerOf(who, org, [`${granted.kind}.read`]),
      [member.id, open.id, hidden.id, granted.id, foreign.id, uuidv7()]
    );

    expect([...readable.keys()].sort()).toEqual(
      [member.id, open.id, granted.id].sort()
    );
    expect(readable.get(open.id)?.id).toBe(open.id);
  });

  it("returns an empty map for no ids", async () => {
    const who = await fixtures.principal();

    expect((await readableSpaces(callerOf(who, uuidv7()), [])).size).toBe(0);
  });
});
