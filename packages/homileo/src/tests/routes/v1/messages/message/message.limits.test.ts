// @module-tag int
// @module-tag messages
// @module-tag security
import { MESSAGE_BODY_MAX } from "../../../../../routes/v1/sessions/session/messages/schemas.js";
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  editMessage,
  notificationsTo,
  sendMessage,
} from "../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

describe("PATCH /v1/messages/:messageId", () => {
  it.each([
    ["> nesting", ">"],
    ["'- ' nesting", "- "],
  ])(
    "edits to a full-size body of %s as plain text, with its mentions",
    async (_name, marker) => {
      const org = uuidv7();
      orgs.push(org);
      const me = await signIn(org);
      const session = await fixtures.session({ org });
      await fixtures.participant(session, { id: me.principalId }, "owner");
      const other = await fixtures.principal();
      await fixtures.participant(session, other);
      await prisma.principal.update({
        where: { id: other.id },
        data: { displayName: "Other" },
      });
      const sent = await sendMessage(session.id, me.token, { body: "x" });
      const id = sent.body.message.id;
      const tail = `x <@${other.id}>`;
      const body =
        marker.repeat((MESSAGE_BODY_MAX - tail.length) / marker.length) + tail;

      const res = await editMessage(id, me.token, { body });

      expect(res.status).toBe(200);
      const row = await prisma.message.findUniqueOrThrow({ where: { id } });
      expect(row.bodyText).toBe(body.replace(tail, "x @Other"));
      const mentions = await prisma.messageMention.findMany({
        where: { messageId: id },
      });
      expect(mentions.map((m) => m.userId)).toEqual([other.id]);
    }
  );

  it("decides who is newly mentioned without reading the earlier revisions", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: me.principalId }, "owner");
    const other = await fixtures.principal();
    await fixtures.participant(session, other);
    const sent = await sendMessage(session.id, me.token, { body: "x" });
    const id = sent.body.message.id;
    const lazy = "b\n".repeat(900);
    // Revisions an edit that parsed them would find the mention in.
    const stored = 500;
    await prisma.messageRevision.createMany({
      data: Array.from({ length: stored }, (_, k) => ({
        messageId: id,
        revision: k + 2,
        body: `> <@${other.id}> ${k}\n${lazy}`,
        editedBy: me.principalId,
      })),
    });
    await prisma.message.update({
      where: { id },
      data: { revision: stored + 1 },
    });

    const res = await editMessage(id, me.token, { body: `<@${other.id}>` });

    expect(res.status).toBe(200);
    expect(res.body.message.revision).toBe(stored + 2);
    expect(await notificationsTo(other.tereoUserId!)).toHaveLength(1);
  });
});
