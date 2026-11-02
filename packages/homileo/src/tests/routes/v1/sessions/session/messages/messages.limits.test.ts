// @module-tag int
// @module-tag sessions
// @module-tag messages
// @module-tag security
import { MESSAGE_BODY_MAX } from "../../../../../../routes/v1/sessions/session/messages/schemas.js";
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

describe("POST /v1/sessions/:sessionId/messages", () => {
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
});
