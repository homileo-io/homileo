// @module-tag int
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  editMessage,
  getMessage,
  notificationsTo,
  sendMessage,
} from "../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId }, "owner");
  return { org, me, session };
};

const mentionIds = async (messageId: string) =>
  (await prisma.messageMention.findMany({ where: { messageId } }))
    .map((m) => m.userId ?? "broadcast")
    .sort();

describe("GET /v1/messages/:messageId", () => {
  it("returns the message", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "hi" });

    const res = await getMessage(sent.body.message.id, me.token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: sent.body.message });
  });

  it("returns a deleted message with no body, attachments or reactions", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "hi" });
    await deleteMessage(sent.body.message.id, me.token);

    const res = await getMessage(sent.body.message.id, me.token);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({
      body: null,
      payload: null,
      attachments: [],
      reactions: [],
      deletedBy: me.principalId,
    });
    expect(res.body.message.deletedAt).not.toBeNull();
  });
});

describe("PATCH /v1/messages/:messageId", () => {
  it("edits twice and keeps every revision, the original first", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "one" });
    const id = sent.body.message.id;

    const first = await editMessage(id, me.token, { body: "two" });
    const second = await editMessage(id, me.token, { body: "three" });

    expect(first.status).toBe(200);
    expect(first.body.message).toMatchObject({
      body: "two",
      revision: 2,
    });
    expect(first.body.message.editedAt).not.toBeNull();
    expect(second.body.message).toMatchObject({ body: "three", revision: 3 });
    const revisions = await prisma.messageRevision.findMany({
      where: { messageId: id },
      orderBy: { revision: "asc" },
    });
    expect(revisions.map((r) => [r.revision, r.body, r.editedBy])).toEqual([
      [1, "one", me.principalId],
      [2, "two", me.principalId],
      [3, "three", me.principalId],
    ]);
    const row = await prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row.bodyText).toBe("three");
  });

  it("changes metadata alone without a revision or editedAt", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "one" });

    const res = await editMessage(sent.body.message.id, me.token, {
      metadata: { pinned: "yes" },
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({
      metadata: { pinned: "yes" },
      revision: 1,
      editedAt: null,
      body: "one",
    });
    expect(
      await prisma.messageRevision.count({
        where: { messageId: sent.body.message.id },
      })
    ).toBe(1);
  });

  it("answers 200 and changes nothing for an edit that changes nothing", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "one" });

    const res = await editMessage(sent.body.message.id, me.token, {
      body: "one",
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toEqual(sent.body.message);
  });

  it("rewrites the mention rows and notifies only the newly mentioned", async () => {
    const { me, session } = await room();
    const a = await fixtures.principal();
    const b = await fixtures.principal();
    await fixtures.participant(session, a);
    await fixtures.participant(session, b);
    const sent = await sendMessage(session.id, me.token, {
      body: `<@${a.id}> hello`,
    });
    const id = sent.body.message.id;
    expect(await notificationsTo(a.tereoUserId!)).toHaveLength(1);

    const res = await editMessage(id, me.token, {
      body: `<@${a.id}> <@${b.id}> <!here> hello`,
    });

    expect(res.status).toBe(200);
    expect(await mentionIds(id)).toEqual([a.id, b.id, "broadcast"].sort());
    expect(await notificationsTo(a.tereoUserId!)).toHaveLength(1);
    expect(await notificationsTo(b.tereoUserId!)).toHaveLength(1);

    await editMessage(id, me.token, { body: `<@${b.id}> bye` });
    expect(await mentionIds(id)).toEqual([b.id]);
    expect(await notificationsTo(b.tereoUserId!)).toHaveLength(1);
  });

  it("leaves a malformed id as text and stores at most 100 user mentions", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "x" });
    const id = sent.body.message.id;

    const bad = await editMessage(id, me.token, {
      body: "<@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> hi",
    });
    const rowsAfterBad = await mentionIds(id);
    const many = Array.from({ length: 101 }, () => uuidv7());
    const principals = await prisma.principal.createManyAndReturn({
      data: many.map((tereoUserId) => ({ kind: "user", tereoUserId })),
    });
    for (const p of principals) await fixtures.participant(session, p);
    const big = await editMessage(id, me.token, {
      body: principals.map((p) => `<@${p.id}>`).join(" "),
    });

    expect(bad.status).toBe(200);
    expect(rowsAfterBad).toEqual([]);
    expect(big.status).toBe(200);
    expect(await mentionIds(id)).toHaveLength(100);
    await prisma.sessionParticipant.deleteMany({
      where: {
        sessionId: session.id,
        userId: { in: principals.map((p) => p.id) },
      },
    });
    await prisma.messageMention.deleteMany({ where: { messageId: id } });
    await prisma.principal.deleteMany({
      where: { id: { in: principals.map((p) => p.id) } },
    });
  });

  it("serializes two concurrent edits into revisions N+1 and N+2", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "one" });
    const id = sent.body.message.id;

    const results = await Promise.all([
      editMessage(id, me.token, { body: "a" }),
      editMessage(id, me.token, { body: "b" }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.body.message.revision).sort()).toEqual([2, 3]);
    const revisions = await prisma.messageRevision.findMany({
      where: { messageId: id },
      orderBy: { revision: "asc" },
    });
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  it("recomputes body_text with mention names", async () => {
    const { me, session } = await room();
    const ada = await prisma.principal.update({
      where: { id: (await fixtures.principal()).id },
      data: { displayName: "Ada" },
    });
    await fixtures.participant(session, ada);
    const sent = await sendMessage(session.id, me.token, { body: "x" });

    await editMessage(sent.body.message.id, me.token, {
      body: `hi **<@${ada.id}>**`,
    });

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.body.message.id },
    });
    expect(row.bodyText).toBe("hi @Ada");
  });

  it("refuses a payload on a text message with 400 invalid_payload", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "x" });

    const res = await editMessage(sent.body.message.id, me.token, {
      payload: { a: 1 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
  });

  it("answers 409 resource_archived for a deleted message", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "x" });
    await deleteMessage(sent.body.message.id, me.token);

    const res = await editMessage(sent.body.message.id, me.token, {
      body: "y",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });
});

describe("DELETE /v1/messages/:messageId", () => {
  it("clears the message and keeps its revisions and mentions' removal", async () => {
    const { me, session } = await room();
    const a = await fixtures.principal();
    await fixtures.participant(session, a);
    const sent = await sendMessage(session.id, me.token, {
      body: `<@${a.id}> secret`,
    });
    const id = sent.body.message.id;
    await editMessage(id, me.token, { body: `<@${a.id}> secret 2` });

    const res = await deleteMessage(id, me.token);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({
      id,
      body: null,
      payload: null,
      attachments: [],
      reactions: [],
      deletedBy: me.principalId,
    });
    const row = await prisma.message.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ body: null, bodyText: null, payload: null });
    expect(await mentionIds(id)).toEqual([]);
    expect(
      await prisma.messageRevision.count({ where: { messageId: id } })
    ).toBe(2);
  });

  it("drops the root's replyCount when a reply is deleted", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const r1 = await sendMessage(session.id, me.token, {
      body: "r1",
      threadRootId: root.body.message.id,
    });
    await sendMessage(session.id, me.token, {
      body: "r2",
      threadRootId: root.body.message.id,
    });

    const res = await deleteMessage(r1.body.message.id, me.token);

    expect(res.status).toBe(200);
    const after = await getMessage(root.body.message.id, me.token);
    expect(after.body.message.replyCount).toBe(1);
  });

  it("moves the root's lastReplyAt to the surviving reply, or to null", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const rootId = root.body.message.id;
    const r1 = await sendMessage(session.id, me.token, {
      body: "r1",
      threadRootId: rootId,
    });
    const r2 = await sendMessage(session.id, me.token, {
      body: "r2",
      threadRootId: rootId,
    });

    await deleteMessage(r2.body.message.id, me.token);
    const one = await getMessage(rootId, me.token);
    await deleteMessage(r1.body.message.id, me.token);
    const none = await getMessage(rootId, me.token);

    expect(one.body.message.replyCount).toBe(1);
    expect(one.body.message.lastReplyAt).toBe(r1.body.message.createdAt);
    expect(none.body.message.replyCount).toBe(0);
    expect(none.body.message.lastReplyAt).toBeNull();
  });

  it("answers 409 resource_archived when it is already deleted", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "x" });
    await deleteMessage(sent.body.message.id, me.token);

    const res = await deleteMessage(sent.body.message.id, me.token);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });
});
