// @module-tag int
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const put = (rootId: string, token: string, body: unknown) =>
  fetchJson(
    "PUT",
    `${env.PUBLIC_URL}/v1/threads/${rootId}/follow`,
    token,
    body
  );

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const author = await signIn(org);
  const other = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: author.principalId });
  await fixtures.participant(session, { id: other.principalId });
  const root = await sendMessage(session.id, author.token, { body: "root" });
  const rootId: string = root.body.message.id;
  const reply = (token: string) =>
    sendMessage(session.id, token, { body: "r", threadRootId: rootId });
  return { org, author, other, session, rootId, reply };
};

const rowOf = (rootId: string, userId: string) =>
  prisma.threadFollower.findUnique({
    where: { threadRootId_userId: { threadRootId: rootId, userId } },
  });

describe("PUT /v1/threads/:rootId/follow", () => {
  it("creates a row that starts unread, then toggles it, recording no event", async () => {
    const { other, session, rootId } = await room();

    expect((await put(rootId, other.token, { following: true })).body).toEqual({
      following: true,
    });
    expect((await rowOf(rootId, other.principalId))?.lastReadSeq).toBe(0n);
    expect((await put(rootId, other.token, { following: false })).body).toEqual(
      {
        following: false,
      }
    );
    expect((await rowOf(rootId, other.principalId))?.following).toBe(false);
    expect(
      await prisma.event.count({
        where: { sessionId: session.id, type: "read.updated" },
      })
    ).toBe(0);
  });

  it("is not undone by someone else's reply, but a reply by the caller follows again", async () => {
    const { author, other, rootId, reply } = await room();
    await reply(other.token);
    expect((await rowOf(rootId, author.principalId))?.following).toBe(true);

    await put(rootId, author.token, { following: false });
    await reply(other.token);
    expect((await rowOf(rootId, author.principalId))?.following).toBe(false);

    await reply(author.token);
    expect((await rowOf(rootId, author.principalId))?.following).toBe(true);
  });

  it("answers 404 to a non-reader, 400 for a reply or a bad body", async () => {
    const { org, author, rootId, reply } = await room();
    const sent = await reply(author.token);
    const stranger = await signIn(org);

    expect(
      (await put(rootId, stranger.token, { following: true })).status
    ).toBe(404);
    const refused = await put(sent.body.message.id, author.token, {
      following: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("reply_to_reply");
    for (const body of [{}, { following: "yes" }, { following: true, x: 1 }]) {
      expect((await put(rootId, author.token, body)).status).toBe(400);
    }
    expect((await put("nope", author.token, { following: true })).status).toBe(
      400
    );
  });
});
