// @module-tag int
// @module-tag sessions
// @module-tag messages
// @module-tag access
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { botToken } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  listMessages,
  sendMessage,
} from "../../../../../support/messageApi.js";

const fixtures = chatFixtures();
const orgs: string[] = [];
const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

describe("POST /v1/sessions/:sessionId/messages permissions", () => {
  it("refuses a reader who is not a participant with 403 not_a_participant", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const reader = await signIn(org);

    const res = await sendMessage(s.id, reader.token, { body: "hi" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_participant");
  });

  it("refuses a member in a moderators-only space with 403 posting_restricted, and lets a moderator post", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org, postPolicy: "moderators" });
    const s = await fixtures.session({ org, space, access: "space" });
    const member = await signIn(org);
    const moderator = await signIn(org);
    await fixtures.member(space, { id: member.principalId });
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.participant(s, { id: member.principalId });
    await fixtures.participant(s, { id: moderator.principalId });

    const refused = await sendMessage(s.id, member.token, { body: "hi" });
    const allowed = await sendMessage(s.id, moderator.token, { body: "hi" });

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("posting_restricted");
    expect(allowed.status).toBe(201);
  });

  it("refuses an archived session with 409 resource_archived", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org, archived: true });
    const me = await signIn(org);
    await fixtures.participant(s, { id: me.principalId }, "owner");

    const res = await sendMessage(s.id, me.token, { body: "hi" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });

  it("lets a bot post with its own token", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const token = botToken({ org });
    const me = await fetchJson("GET", `${env.PUBLIC_URL}/v1/me`, token);
    expect(me.body.principal.isBot).toBe(true);
    await fixtures.participant(s, { id: me.body.principal.id });

    const res = await sendMessage(s.id, token, { body: "beep" });

    expect(res.status).toBe(201);
    expect(res.body.message.senderId).toBe(me.body.principal.id);
  });
});

describe("reading messages", () => {
  it("answers 404 on POST and GET to a caller who cannot read the session, and in another organization", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const outsider = await signIn(org);
    const foreign = await signIn(newOrg());
    await fixtures.participant(s, { id: foreign.principalId });

    for (const who of [outsider, foreign]) {
      const post = await sendMessage(s.id, who.token, { body: "hi" });
      const get = await listMessages(s.id, who.token);
      expect(post.status).toBe(404);
      expect(get.status).toBe(404);
    }
  });

  it("answers 404 for an unknown session and 400 for an id that is not a UUID", async () => {
    const me = await signIn(newOrg());

    expect((await listMessages(uuidv7(), me.token)).status).toBe(404);
    expect((await listMessages("nope", me.token)).status).toBe(400);
    expect((await sendMessage("nope", me.token, { body: "hi" })).status).toBe(
      400
    );
  });

  it("lets a removed participant still reading through access: space list messages", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org });
    const s = await fixtures.session({ org, space, access: "space" });
    const author = await signIn(org);
    const removed = await signIn(org);
    for (const who of [author, removed]) {
      await fixtures.member(space, { id: who.principalId });
    }
    await fixtures.participant(s, { id: author.principalId });
    await fixtures.participant(s, { id: removed.principalId }, "member", {
      left: true,
    });
    await sendMessage(s.id, author.token, { body: "still visible" });

    const res = await listMessages(s.id, removed.token);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(
      (await sendMessage(s.id, removed.token, { body: "x" })).body.error
    ).toBe("not_a_participant");
  });
});
