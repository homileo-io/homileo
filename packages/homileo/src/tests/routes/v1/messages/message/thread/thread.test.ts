// @module-tag int
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  messageUrl,
  sendMessage,
} from "../../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const getThread = (id: string, token: string, query = "") =>
  fetchJson("GET", `${messageUrl(id)}/thread${query}`, token);

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId });
  const root = await sendMessage(session.id, me.token, { body: "root" });
  const rootId: string = root.body.message.id;
  const reply = (body: string, token = me.token) =>
    sendMessage(session.id, token, { body, threadRootId: rootId });
  return { org, me, session, rootId, reply };
};

describe("GET /v1/messages/:messageId/thread", () => {
  it("lists the replies only, ascending, with the root and the caller's follower row", async () => {
    const { me, session, rootId, reply } = await room();
    await sendMessage(session.id, me.token, { body: "elsewhere" });
    await reply("one");
    await reply("two");

    const res = await getThread(rootId, me.token);

    expect(res.status).toBe(200);
    expect(res.body.root).toMatchObject({ id: rootId, replyCount: 2 });
    expect(res.body.data.map((m: { body: string }) => m.body)).toEqual([
      "one",
      "two",
    ]);
    expect(res.body.hasAfter).toBe(false);
    expect(res.body.follower).toEqual({ following: true, lastReadSeq: 4 });
  });

  it("pages with after and limit, and reports a null follower for a reader with no row", async () => {
    const { org, rootId, reply, me } = await room();
    for (const b of ["a", "b", "c"]) await reply(b);
    const first = await getThread(rootId, me.token, "?limit=2");
    expect(first.body.data.map((m: { body: string }) => m.body)).toEqual([
      "a",
      "b",
    ]);
    expect(first.body.hasAfter).toBe(true);

    const next = await getThread(
      rootId,
      me.token,
      `?limit=2&after=${first.body.data[1].seq}`
    );
    expect(next.body.data.map((m: { body: string }) => m.body)).toEqual(["c"]);
    expect(next.body.hasAfter).toBe(false);

    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ org, space, access: "space" });
    const author = await signIn(org);
    await fixtures.participant(open, { id: author.principalId });
    const reader = await signIn(org);
    const r = await sendMessage(open.id, author.token, { body: "r" });
    const seen = await getThread(r.body.message.id, reader.token);
    expect(seen.status).toBe(200);
    expect(seen.body.follower).toBeNull();
    expect(seen.body.data).toEqual([]);
  });

  it("answers 400 reply_to_reply for a reply, 400 for a bad limit, 404 to a non-reader", async () => {
    const { org, me, rootId, reply } = await room();
    const sent = await reply("x");
    const stranger = await signIn(org);

    const refused = await getThread(sent.body.message.id, me.token);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("reply_to_reply");
    expect((await getThread(rootId, me.token, "?limit=101")).status).toBe(400);
    expect((await getThread(rootId, me.token, "?after=-1")).status).toBe(400);
    expect((await getThread(rootId, stranger.token)).status).toBe(404);
    expect((await getThread("nope", me.token)).status).toBe(400);
  });

  it("still shows a deleted root, cleared", async () => {
    const { me, rootId, reply } = await room();
    await reply("kept");
    await deleteMessage(rootId, me.token);

    const res = await getThread(rootId, me.token);

    expect(res.status).toBe(200);
    expect(res.body.root.deletedAt).not.toBeNull();
    expect(res.body.root.body).toBeNull();
    expect(res.body.data).toHaveLength(1);
  });
});
