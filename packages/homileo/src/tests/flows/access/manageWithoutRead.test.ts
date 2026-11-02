// @module-tag int
// @module-tag access
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../support/signedIn.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { sendMessage } from "../../support/messageApi.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../../env.js";

const fixtures = chatFixtures();
const orgs: string[] = [];
const url = env.PUBLIC_URL;

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

/** An `access: members` session in a space, with a message, that its space's moderators do not take part in. */
const unreadSession = async () => {
  const org = uuidv7();
  orgs.push(org);
  const space = await fixtures.space({ org, visibility: "members" });
  const [owner, moderator, member, alice, bob] = await Promise.all(
    Array.from({ length: 5 }, () => signIn(org))
  );
  await fixtures.member(space, { id: owner.principalId }, "owner");
  await fixtures.member(space, { id: moderator.principalId }, "moderator");
  for (const who of [member, alice, bob]) {
    await fixtures.member(space, { id: who.principalId });
  }
  const session = await fixtures.session({ space, access: "members" });
  await fixtures.participant(session, { id: alice.principalId });
  await fixtures.participant(session, { id: bob.principalId });
  const sent = await sendMessage(session.id, alice.token, { body: "private" });
  expect(sent.status).toBe(201);
  const messageId: string = sent.body.message.id;
  return { owner, moderator, member, alice, bob, session, messageId };
};

const archive = (id: string, token: string) =>
  fetchJson("POST", `${url}/v1/sessions/${id}/archive`, token);
const remove = (id: string, principalId: string, token: string) =>
  fetchJson(
    "DELETE",
    `${url}/v1/sessions/${id}/participants/${principalId}`,
    token
  );
const deleteMessage = (id: string, token: string) =>
  fetchJson("DELETE", `${url}/v1/messages/${id}`, token);

describe("space moderators who do not take part in an access: members session", () => {
  it("archive it with 204 and no body, and still cannot read it", async () => {
    const { moderator, session } = await unreadSession();

    const res = await archive(session.id, moderator.token);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.archivedAt).not.toBeNull();
    const read = await fetchJson(
      "GET",
      `${url}/v1/sessions/${session.id}`,
      moderator.token
    );
    expect(read.status).toBe(404);
  });

  it("remove its participants with 204", async () => {
    const { owner, bob, session } = await unreadSession();

    const res = await remove(session.id, bob.principalId, owner.token);

    expect(res.status).toBe(204);
    const row = await prisma.sessionParticipant.findUniqueOrThrow({
      where: {
        sessionId_userId: { sessionId: session.id, userId: bob.principalId },
      },
    });
    expect(row.leftAt).not.toBeNull();
  });

  it("delete its messages with 204 and no view of the message", async () => {
    const { moderator, messageId } = await unreadSession();

    const res = await deleteMessage(messageId, moderator.token);

    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(moderator.principalId);
    const read = await fetchJson(
      "GET",
      `${url}/v1/messages/${messageId}`,
      moderator.token
    );
    expect(read.status).toBe(404);
  });

  it("still answer 409 for an already deleted message", async () => {
    const { moderator, messageId } = await unreadSession();
    await deleteMessage(messageId, moderator.token);

    const res = await deleteMessage(messageId, moderator.token);

    expect(res.status).toBe(409);
  });

  it("gives a moderator who reads the session the deleted message's view", async () => {
    const { moderator, session, messageId } = await unreadSession();
    await fixtures.participant(session, { id: moderator.principalId });

    const res = await deleteMessage(messageId, moderator.token);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ id: messageId, body: null });
  });

  it("leaves a plain space member who does not take part at 404 for all three", async () => {
    const { member, bob, session, messageId } = await unreadSession();

    const answers = [
      await archive(session.id, member.token),
      await remove(session.id, bob.principalId, member.token),
      await deleteMessage(messageId, member.token),
    ];

    expect(answers.map((a) => a.status)).toEqual([404, 404, 404]);
  });
});

describe("homileo.chat.admin and a DM it does not take part in", () => {
  it("still answers 404 to deleting one of its messages", async () => {
    const org = uuidv7();
    orgs.push(org);
    const [a, b] = await Promise.all([signIn(org), signIn(org)]);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    fixtures.organization(org);
    const dm = await fetchJson("POST", `${url}/v1/sessions/direct`, a.token, {
      principalId: b.principalId,
    });
    const sent = await sendMessage(dm.body.session.id, a.token, {
      body: "just us",
    });
    expect(sent.status).toBe(201);

    const res = await deleteMessage(sent.body.message.id, admin.token);

    expect(res.status).toBe(404);
  });
});
