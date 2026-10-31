// @module-tag int
// @module-tag sessions
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { MessageSchema } from "@homileo-io/sdk";
import { v7 as uuidv7 } from "uuid";
import {
  listMessages,
  notificationsTo,
  sendMessage,
} from "../../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];
const types: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
  await prisma.provisionedMessageType.deleteMany({
    where: { name: { in: types } },
  });
});

/** A space-less group whose owner is the signed-in `me`. */
const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId }, "owner");
  return { org, me, session };
};

const messageType = async (
  payloadSchema: object,
  o: { retired?: boolean } = {}
) => {
  const name = `msg-test:${uuidv7().slice(-12)}`;
  types.push(name);
  await prisma.provisionedMessageType.create({
    data: {
      name,
      app: "msg-test",
      payloadSchema,
      documentVersion: "1.0.0",
      sourceFile: "msg-test.json",
      retiredAt: o.retired ? new Date() : null,
    },
  });
  return name;
};

describe("POST and GET /v1/sessions/:sessionId/messages", () => {
  it("sends a message and lists it", async () => {
    const { me, session } = await room();

    const sent = await sendMessage(session.id, me.token, { body: "hello" });

    expect(sent.status).toBe(201);
    expect(MessageSchema.parse(sent.body.message)).toMatchObject({
      sessionId: session.id,
      seq: 1,
      senderId: me.principalId,
      type: "text",
      body: "hello",
      payload: null,
      threadRootId: null,
      replyCount: 0,
      revision: 1,
      attachments: [],
      reactions: [],
    });
    const listed = await listMessages(session.id, me.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      data: [sent.body.message],
      hasBefore: false,
      hasAfter: false,
    });
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.lastSeq).toBe(1n);
    expect(row.lastMessageAt).not.toBeNull();
    const revisions = await prisma.messageRevision.findMany({
      where: { messageId: sent.body.message.id },
    });
    expect(revisions).toMatchObject([
      { revision: 1, body: "hello", editedBy: me.principalId },
    ]);
  });

  it("pages with before, after and around over 7 messages", async () => {
    const { me, session } = await room();
    for (let i = 1; i <= 7; i++) {
      await sendMessage(session.id, me.token, { body: `m${i}` });
    }
    const page = async (query: string) => {
      const res = await listMessages(session.id, me.token, query);
      expect(res.status).toBe(200);
      return {
        seqs: res.body.data.map((m: { seq: number }) => m.seq),
        hasBefore: res.body.hasBefore,
        hasAfter: res.body.hasAfter,
      };
    };

    expect(await page("?limit=3")).toEqual({
      seqs: [5, 6, 7],
      hasBefore: true,
      hasAfter: false,
    });
    expect(await page("?limit=3&before=5")).toEqual({
      seqs: [2, 3, 4],
      hasBefore: true,
      hasAfter: true,
    });
    expect(await page("?limit=3&before=2")).toEqual({
      seqs: [1],
      hasBefore: false,
      hasAfter: true,
    });
    expect(await page("?limit=3&after=0")).toEqual({
      seqs: [1, 2, 3],
      hasBefore: false,
      hasAfter: true,
    });
    expect(await page("?limit=3&after=4")).toEqual({
      seqs: [5, 6, 7],
      hasBefore: true,
      hasAfter: false,
    });
    expect(await page("?limit=3&around=4")).toEqual({
      seqs: [3, 4, 5],
      hasBefore: true,
      hasAfter: true,
    });
    expect(await page("?limit=3&around=1")).toEqual({
      seqs: [1, 2],
      hasBefore: false,
      hasAfter: true,
    });
    expect(await page("?limit=3&around=7")).toEqual({
      seqs: [6, 7],
      hasBefore: true,
      hasAfter: false,
    });
  });

  it("refuses two of before, after and around with 400", async () => {
    const { me, session } = await room();

    const res = await listMessages(session.id, me.token, "?before=3&after=1");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("refuses a body without a clientMessageId with 400 invalid_request", async () => {
    const { me, session } = await room();

    const res = await sendMessage(session.id, me.token, {
      clientMessageId: undefined,
      body: "x",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("sets the sender's last_read_seq to the new seq", async () => {
    const { me, session } = await room();
    await sendMessage(session.id, me.token, { body: "one" });

    const sent = await sendMessage(session.id, me.token, { body: "two" });

    const participant = await prisma.sessionParticipant.findUniqueOrThrow({
      where: {
        sessionId_userId: { sessionId: session.id, userId: me.principalId },
      },
    });
    expect(sent.body.message.seq).toBe(2);
    expect(participant.lastReadSeq).toBe(2n);
  });
});

describe("thread replies", () => {
  it("leaves replies out of the list and counts them on the root", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const reply = await sendMessage(session.id, me.token, {
      body: "reply",
      threadRootId: root.body.message.id,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.message).toMatchObject({
      seq: 2,
      threadRootId: root.body.message.id,
    });
    const listed = await listMessages(session.id, me.token);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      id: root.body.message.id,
      replyCount: 1,
    });
    expect(listed.body.data[0].lastReplyAt).toBe(reply.body.message.createdAt);
  });

  it("makes the root's sender and the replier followers, and leaves lastMessageAt", async () => {
    const { org, me, session } = await room();
    const other = await signIn(org);
    await fixtures.participant(session, { id: other.principalId });
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const before = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });

    const reply = await sendMessage(session.id, other.token, {
      body: "reply",
      threadRootId: root.body.message.id,
    });

    expect(reply.status).toBe(201);
    const rootRow = await prisma.message.findUniqueOrThrow({
      where: { id: root.body.message.id },
    });
    expect(rootRow.replyCount).toBe(1);
    const followers = await prisma.threadFollower.findMany({
      where: { threadRootId: root.body.message.id },
      orderBy: { lastReadSeq: "asc" },
    });
    expect(
      followers.map((f) => [f.userId, f.following, f.lastReadSeq])
    ).toEqual([
      [me.principalId, true, 0n],
      [other.principalId, true, 2n],
    ]);
    const after = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(after.lastSeq).toBe(2n);
    expect(after.lastMessageAt).toEqual(before.lastMessageAt);
  });

  it("refuses a reply to a reply with 400 reply_to_reply", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const reply = await sendMessage(session.id, me.token, {
      body: "reply",
      threadRootId: root.body.message.id,
    });

    const res = await sendMessage(session.id, me.token, {
      body: "deeper",
      threadRootId: reply.body.message.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("reply_to_reply");
  });

  it("refuses an unknown, deleted or other session's root with 400 at threadRootId", async () => {
    const { me, session } = await room();
    const elsewhere = await fixtures.session({ org: session.organizationId });
    await fixtures.participant(elsewhere, { id: me.principalId });
    const foreign = await sendMessage(elsewhere.id, me.token, { body: "x" });
    const deleted = await sendMessage(session.id, me.token, { body: "gone" });
    await prisma.message.update({
      where: { id: deleted.body.message.id },
      data: { deletedAt: new Date(), body: null },
    });

    for (const rootId of [
      uuidv7(),
      foreign.body.message.id,
      deleted.body.message.id,
    ]) {
      const res = await sendMessage(session.id, me.token, {
        body: "reply",
        threadRootId: rootId,
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: "invalid_request",
        issues: [{ path: "threadRootId" }],
      });
    }
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.lastSeq).toBe(1n);
  });
});

describe("message types", () => {
  const schema = {
    type: "object",
    required: ["amount"],
    properties: { amount: { type: "number" } },
  };

  it("validates a custom type's payload against its provisioned schema", async () => {
    const { me, session } = await room();
    const type = await messageType(schema);

    const ok = await sendMessage(session.id, me.token, {
      type,
      payload: { amount: 3 },
    });
    const bad = await sendMessage(session.id, me.token, {
      type,
      payload: { amount: "three" },
    });

    expect(ok.status).toBe(201);
    expect(ok.body.message).toMatchObject({
      type,
      payload: { amount: 3 },
      body: null,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_payload");
    expect(bad.body.issues).toEqual([
      { path: "payload.amount", message: expect.any(String) },
    ]);
  });

  it("refuses a retired or unknown type with 400 message_type_not_found", async () => {
    const { me, session } = await room();
    const retired = await messageType(schema, { retired: true });

    for (const type of [retired, "msg-test:never-declared"]) {
      const res = await sendMessage(session.id, me.token, {
        type,
        payload: { amount: 1 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_type_not_found");
    }
  });
});

describe("mentions", () => {
  const named = async (displayName: string) => {
    const p = await fixtures.principal();
    return prisma.principal.update({
      where: { id: p.id },
      data: { displayName },
    });
  };

  const mentionRows = (messageId: string) =>
    prisma.messageMention.findMany({ where: { messageId } });

  it("stores @<name> in body_text", async () => {
    const { me, session } = await room();
    const ada = await named("Ada");
    await fixtures.participant(session, ada);

    const sent = await sendMessage(session.id, me.token, {
      body: `hi **<@${ada.id}>** and <!here>`,
    });

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.body.message.id },
    });
    expect(row.bodyText).toBe("hi @Ada and @here");
  });

  it("stores and notifies a reader, and neither for a principal who cannot read the session", async () => {
    const { me, session } = await room();
    await prisma.principal.update({
      where: { id: me.principalId },
      data: { displayName: "Grace" },
    });
    const reader = await named("Reader");
    const outsider = await named("Outsider");
    await fixtures.participant(session, reader);

    const sent = await sendMessage(session.id, me.token, {
      body: `<@${reader.id}> <@${outsider.id}> look`,
    });

    expect(sent.status).toBe(201);
    const rows = await mentionRows(sent.body.message.id);
    expect(rows.map((r) => [r.kind, r.userId])).toEqual([["user", reader.id]]);
    const notes = await notificationsTo(reader.tereoUserId!);
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toMatchObject({
      channel: "email",
      organizationId: session.organizationId,
      recipients: [{ userId: reader.tereoUserId }],
      content: {
        subject: "Grace mentioned you",
        text: "@Reader @Outsider look",
      },
    });
    expect(await notificationsTo(outsider.tereoUserId!)).toEqual([]);
  });

  it("stores a mention of a reader with notify none and sends no notification", async () => {
    const { me, session } = await room();
    const quiet = await named("Quiet");
    await fixtures.participant(session, quiet);
    await prisma.sessionParticipant.update({
      where: {
        sessionId_userId: { sessionId: session.id, userId: quiet.id },
      },
      data: { notify: "none" },
    });

    const sent = await sendMessage(session.id, me.token, {
      body: `<@${quiet.id}> <!session>`,
    });

    const rows = await mentionRows(sent.body.message.id);
    expect(rows.map((r) => [r.kind, r.userId]).sort()).toEqual([
      ["session", null],
      ["user", quiet.id],
    ]);
    expect(await notificationsTo(quiet.tereoUserId!)).toEqual([]);
  });

  it("notifies neither the sender nor a bot", async () => {
    const { me, session } = await room();
    const bot = await fixtures.principal({ isBot: true });
    await fixtures.participant(session, bot);

    const sent = await sendMessage(session.id, me.token, {
      body: `<@${me.principalId}> <@${bot.id}>`,
    });

    const rows = await mentionRows(sent.body.message.id);
    expect(rows.map((r) => r.userId).sort()).toEqual(
      [me.principalId, bot.id].sort()
    );
    expect(await notificationsTo(me.tereoUserId)).toEqual([]);
    expect(await notificationsTo(bot.tereoUserId!)).toEqual([]);
  });

  it("stores and notifies a space member who reads an access: space session without participating", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const space = await fixtures.space({ org });
    const s = await fixtures.session({ org, space, access: "space" });
    await fixtures.member(space, { id: me.principalId });
    await fixtures.participant(s, { id: me.principalId });
    const member = await named("Member");
    await fixtures.member(space, member);

    const sent = await sendMessage(s.id, me.token, {
      body: `<@${member.id}>`,
    });

    expect(sent.status).toBe(201);
    expect(
      (await mentionRows(sent.body.message.id)).map((r) => r.userId)
    ).toEqual([member.id]);
    expect(await notificationsTo(member.tereoUserId!)).toHaveLength(1);
  });

  it("stores and notifies nobody for a non-member of a public space, even in another organization", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    await fixtures.member(space, { id: me.principalId });
    await fixtures.participant(s, { id: me.principalId });
    const stranger = await named("Stranger");

    const sent = await sendMessage(s.id, me.token, {
      body: `<@${stranger.id}>`,
    });

    expect(sent.status).toBe(201);
    expect(await mentionRows(sent.body.message.id)).toEqual([]);
    expect(await notificationsTo(stranger.tereoUserId!)).toEqual([]);
  });

  it("leaves a mention token that is not a UUID as text", async () => {
    const { me, session } = await room();

    const sent = await sendMessage(session.id, me.token, {
      body: `hi <@${"a".repeat(36)}> and <@${"-".repeat(36)}>`,
    });

    expect(sent.status).toBe(201);
    expect(await mentionRows(sent.body.message.id)).toEqual([]);
  });

  it("mentions at most the first 100 distinct principals and still names the rest", async () => {
    const { me, session } = await room();
    const people = [];
    for (let i = 0; i < 101; i++) {
      const p = await named(`P${i}`);
      await fixtures.participant(session, p);
      people.push(p);
    }

    const sent = await sendMessage(session.id, me.token, {
      body: people.map((p) => `<@${p.id}>`).join(" "),
    });

    expect(sent.status).toBe(201);
    const rows = await mentionRows(sent.body.message.id);
    expect(rows.map((r) => r.userId).sort()).toEqual(
      people
        .slice(0, 100)
        .map((p) => p.id)
        .sort()
    );
    expect(await notificationsTo(people[100].tereoUserId!)).toEqual([]);
    expect(await notificationsTo(people[99].tereoUserId!)).toHaveLength(1);
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: sent.body.message.id },
    });
    expect(row.bodyText).toMatch(/@P100$/);
  });
});
