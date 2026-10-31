// @module-tag int
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  editMessage,
  listRevisions,
  sendMessage,
} from "../../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const space = await fixtures.space({ org, visibility: "public" });
  const session = await fixtures.session({ org, space, access: "space" });
  const sender = await signIn(org);
  await fixtures.participant(session, { id: sender.principalId });
  const sent = await sendMessage(session.id, sender.token, { body: "one" });
  return { org, space, session, sender, id: sent.body.message.id };
};

describe("GET /v1/messages/:messageId/revisions", () => {
  it("lists the revisions oldest first for the sender", async () => {
    const { sender, id } = await room();
    await editMessage(id, sender.token, { body: "two" });

    const res = await listRevisions(id, sender.token);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { revision: number }) => r.revision)).toEqual([
      1, 2,
    ]);
    expect(res.body.data[0]).toMatchObject({
      revision: 1,
      body: "one",
      payload: null,
      editedBy: sender.principalId,
    });
    expect(typeof res.body.data[0].editedAt).toBe("string");
    expect(res.body.data[1].body).toBe("two");
  });

  it("answers 403 to a plain reader and 404 to a non-reader", async () => {
    const { org, id } = await room();
    const reader = await signIn(org);
    const hidden = await signIn(org);
    const direct = await fixtures.session({ org });
    const member = await signIn(org);
    await fixtures.participant(direct, { id: member.principalId });
    const sent = await sendMessage(direct.id, member.token, { body: "x" });

    expect((await listRevisions(id, reader.token)).status).toBe(403);
    expect(
      (await listRevisions(sent.body.message.id, hidden.token)).status
    ).toBe(404);
  });

  it("lets a space moderator read them, and keeps them after a delete", async () => {
    const { space, session, sender, id } = await room();
    const moderator = await signIn(space.organizationId);
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.participant(session, { id: moderator.principalId });
    await deleteMessage(id, sender.token);

    const res = await listRevisions(id, moderator.token);
    const own = await listRevisions(id, sender.token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].body).toBe("one");
    expect(own.status).toBe(200);
  });
});
