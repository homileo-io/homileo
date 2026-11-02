// @module-tag int
// @module-tag messages
import { REACTION_EMOJI_MAX } from "../../../../../../../utils/db/reactions.js";
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  addReaction,
  removeReaction,
  sendMessage,
} from "../../../../../../support/messageApi.js";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

/** A message already carrying `count` distinct emoji, each from the sender. */
const reacted = async (count: number) => {
  const org = uuidv7();
  orgs.push(org);
  const session = await fixtures.session({ org });
  const sender = await signIn(org);
  const member = await signIn(org);
  await fixtures.participant(session, { id: sender.principalId });
  await fixtures.participant(session, { id: member.principalId });
  const sent = await sendMessage(session.id, sender.token, { body: "one" });
  const id: string = sent.body.message.id;
  await prisma.reaction.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      messageId: id,
      userId: sender.principalId,
      emoji: `:e${i}:`,
    })),
  });
  return { sender, member, id };
};

describe("PUT /v1/messages/:messageId/reactions/:emoji", () => {
  it(`refuses a new emoji past ${REACTION_EMOJI_MAX} distinct ones with 409 reaction_limit`, async () => {
    const { member, id } = await reacted(REACTION_EMOJI_MAX);

    const res = await addReaction(id, member.token, ":one_more:");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reaction_limit");
    expect(await prisma.reaction.count({ where: { messageId: id } })).toBe(
      REACTION_EMOJI_MAX
    );
  });

  it("still takes an emoji the message already has, at the limit", async () => {
    const { member, id } = await reacted(REACTION_EMOJI_MAX);

    const res = await addReaction(id, member.token, ":e0:");

    expect(res.status).toBe(201);
    expect(res.body.reactions).toHaveLength(REACTION_EMOJI_MAX);
  });

  it("takes a new emoji again once one is removed", async () => {
    const { sender, member, id } = await reacted(REACTION_EMOJI_MAX);
    await removeReaction(id, sender.token, ":e0:");

    expect((await addReaction(id, member.token, ":one_more:")).status).toBe(
      201
    );
  });

  it(
    "lets only one of two concurrent new emoji take the last slot",
    { tags: ["race"] },
    async () => {
      const { sender, member, id } = await reacted(REACTION_EMOJI_MAX - 1);

      const results = await Promise.all([
        addReaction(id, sender.token, ":first:"),
        addReaction(id, member.token, ":second:"),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.reaction.count({ where: { messageId: id } })).toBe(
        REACTION_EMOJI_MAX
      );
    }
  );
});
