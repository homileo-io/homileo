// @module-tag int
// @module-tag sessions
// @module-tag messages
// @module-tag security
import { MESSAGE_BODY_MAX } from "../../../../../../routes/v1/sessions/session/messages/schemas.js";
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { MENTION_EMAILS_MAX } from "../../../../../../utils/notifyMentions.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  messagesUrl,
  notificationsTo,
  sendMessage,
} from "../../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

describe("POST /v1/sessions/:sessionId/messages", () => {
  // Built as text: JSON.stringify of a 5,000-deep value overflows a small stack.
  const deep = "[".repeat(5000) + "]".repeat(5000);
  it.each([
    ["payload", `{"type":"text","payload":${deep}}`],
    ["metadata", `{"body":"hi","metadata":{"deep":${deep}}}`],
  ])("answers 400 to a %s nested 5,000 levels deep", async (_name, fields) => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: me.principalId }, "owner");

    const response = await fetch(messagesUrl(session.id), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${me.token}`,
        "Content-Type": "application/json",
      },
      body: `{"clientMessageId":"${uuidv7()}",${fields.slice(1)}`,
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it.each([
    ["> nesting", ">"],
    ["'- ' nesting", "- "],
  ])(
    "sends a full-size body of %s as plain text, with its mentions",
    async (_name, marker) => {
      const org = uuidv7();
      orgs.push(org);
      const me = await signIn(org);
      const session = await fixtures.session({ org });
      await fixtures.participant(session, { id: me.principalId }, "owner");
      await prisma.principal.update({
        where: { id: me.principalId },
        data: { displayName: "Me" },
      });
      const tail = `x <@${me.principalId}> <!here>`;
      const body =
        marker.repeat((MESSAGE_BODY_MAX - tail.length) / marker.length) + tail;

      const sent = await sendMessage(session.id, me.token, { body });

      expect(sent.status).toBe(201);
      const id = sent.body.message.id;
      const row = await prisma.message.findUniqueOrThrow({ where: { id } });
      expect(row.bodyText).toBe(body.replace(tail, "x @Me @here"));
      const mentions = await prisma.messageMention.findMany({
        where: { messageId: id },
      });
      expect(mentions.map((m) => m.userId ?? m.kind).sort()).toEqual(
        [me.principalId, "here"].sort()
      );
    }
  );

  const room = async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: me.principalId }, "owner");
    return { org, me, session };
  };

  it("emails at most MENTION_EMAILS_MAX of the readers it mentions", async () => {
    const { me, session } = await room();
    const readers = [];
    for (let i = 0; i < MENTION_EMAILS_MAX + 5; i++) {
      const p = await fixtures.principal();
      await fixtures.participant(session, p);
      readers.push(p);
    }

    const sent = await sendMessage(session.id, me.token, {
      body: readers.map((p) => `<@${p.id}>`).join(" "),
    });

    expect(sent.status).toBe(201);
    const emailed = await Promise.all(
      readers.map(async (p) => (await notificationsTo(p.tereoUserId!)).length)
    );
    expect(emailed).toEqual(
      readers.map((_, i) => (i < MENTION_EMAILS_MAX ? 1 : 0))
    );
    const mentions = await prisma.messageMention.count({
      where: { messageId: sent.body.message.id },
    });
    expect(mentions).toBe(readers.length);
  });

  it("emails a reader once for a sender's mentions within the cooldown", async () => {
    const { org, me, session } = await room();
    const other = await signIn(org);
    await fixtures.participant(session, { id: other.principalId });
    const reader = await fixtures.principal();
    await fixtures.participant(session, reader);

    await sendMessage(session.id, me.token, { body: `<@${reader.id}> one` });
    await sendMessage(session.id, me.token, { body: `<@${reader.id}> two` });
    expect(await notificationsTo(reader.tereoUserId!)).toHaveLength(1);

    await sendMessage(session.id, other.token, { body: `<@${reader.id}> hi` });
    expect(await notificationsTo(reader.tereoUserId!)).toHaveLength(2);
  });
});
