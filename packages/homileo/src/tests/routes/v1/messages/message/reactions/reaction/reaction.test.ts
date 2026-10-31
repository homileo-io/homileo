// @module-tag int
// @module-tag messages
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  addReaction,
  deleteMessage,
  getMessage,
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

const room = async (o: { postPolicy?: "moderators" } = {}) => {
  const org = uuidv7();
  orgs.push(org);
  const space = await fixtures.space({
    org,
    visibility: "public",
    ...(o.postPolicy && { postPolicy: o.postPolicy }),
  });
  const session = await fixtures.session({ org, space, access: "space" });
  const sender = await signIn(org);
  const member = await signIn(org);
  await fixtures.member(space, { id: sender.principalId }, "moderator");
  await fixtures.participant(session, { id: sender.principalId });
  await fixtures.participant(session, { id: member.principalId });
  const sent = await sendMessage(session.id, sender.token, { body: "one" });
  return { org, space, session, sender, member, id: sent.body.message.id };
};

describe("PUT/DELETE /v1/messages/:messageId/reactions/:emoji", () => {
  it("adds (201), repeats (200), removes (200), and removes again (404)", async () => {
    const { member, id } = await room();

    const added = await addReaction(id, member.token, "👍");
    expect(added.status).toBe(201);
    expect(added.body.reactions).toEqual([
      { emoji: "👍", count: 1, principalIds: [member.principalId] },
    ]);

    const again = await addReaction(id, member.token, "👍");
    expect(again.status).toBe(200);
    expect(again.body.reactions).toEqual(added.body.reactions);

    const removed = await removeReaction(id, member.token, "👍");
    expect(removed.status).toBe(200);
    expect(removed.body.reactions).toEqual([]);

    const gone = await removeReaction(id, member.token, "👍");
    expect(gone.status).toBe(404);
  });

  it("counts several reactors and shows the reactions on the message", async () => {
    const { sender, member, id } = await room();

    await addReaction(id, member.token, "👍🏽");
    const res = await addReaction(id, sender.token, "👍🏽");
    await addReaction(id, sender.token, ":party_parrot:");

    expect(res.body.reactions).toEqual([
      {
        emoji: "👍🏽",
        count: 2,
        principalIds: [member.principalId, sender.principalId],
      },
    ]);
    const message = (await getMessage(id, sender.token)).body.message;
    expect(
      message.reactions.map((r: { emoji: string }) => r.emoji).sort()
    ).toEqual([":party_parrot:", "👍🏽"].sort());
  });

  it("refuses text that is not an emoji or a shortcode with 400", async () => {
    const { member, id } = await room();

    expect((await addReaction(id, member.token, "abc")).status).toBe(400);
    expect(
      (await addReaction(id, member.token, `:${"a".repeat(68)}:`)).status
    ).toBe(400);
    expect((await removeReaction(id, member.token, "abc")).status).toBe(400);
  });

  it("lets a plain participant react in a moderators-only space", async () => {
    const { member, id } = await room({ postPolicy: "moderators" });

    const res = await addReaction(id, member.token, "🎉");

    expect(res.status).toBe(201);
  });

  it("answers 403 not_a_participant to a reader who has not joined, 404 to a non-reader", async () => {
    const { org, id } = await room();
    const reader = await signIn(org);
    const direct = await fixtures.session({ org });
    const owner = await signIn(org);
    await fixtures.participant(direct, { id: owner.principalId });
    const hidden = await signIn(org);
    const sent = await sendMessage(direct.id, owner.token, { body: "x" });

    const refused = await addReaction(id, reader.token, "👍");
    const refusedRemove = await removeReaction(id, reader.token, "👍");

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_a_participant");
    expect(refusedRemove.status).toBe(403);
    expect(
      (await addReaction(sent.body.message.id, hidden.token, "👍")).status
    ).toBe(404);
  });

  it("refuses a deleted message with 409 resource_archived", async () => {
    const { sender, member, id } = await room();
    await addReaction(id, member.token, "👍");
    await deleteMessage(id, sender.token);

    const added = await addReaction(id, member.token, "🎉");
    const removed = await removeReaction(id, member.token, "👍");

    expect(added.status).toBe(409);
    expect(added.body.error).toBe("resource_archived");
    expect(removed.status).toBe(409);
  });

  it("refuses an archived session with 409 resource_archived", async () => {
    const { session, member, id } = await room();
    await (
      await import("../../../../../../../utils/db/prisma.js")
    ).prisma.session.update({
      where: { id: session.id },
      data: { archivedAt: new Date() },
    });

    const res = await addReaction(id, member.token, "👍");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });

  it("answers 401 without a token", async () => {
    const { id } = await room();
    expect((await addReaction(id, "", "👍")).status).toBe(401);
  });
});
