// @module-tag int
// @module-tag access
// @module-tag auth
import { purgeOrganizations, signIn } from "../../support/signedIn.js";
import { addReaction, sendMessage } from "../../support/messageApi.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../support/http.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../../env.js";

const fixtures = chatFixtures();
const org = uuidv7();
const url = env.PUBLIC_URL;

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations([org]);
});

const setup = async () => {
  const writer = await signIn(org);
  const reader = await signIn(org, ["homileo.spaces.read"]);
  const space = await fixtures.space({ org, visibility: "public" });
  const session = await fixtures.session({ space, type: "group" });
  await fixtures.participant(session, { id: writer.principalId });
  await fixtures.participant(session, { id: reader.principalId });
  const root = await sendMessage(session.id, writer.token, { body: "root" });
  expect(root.status).toBe(201);
  return { writer, reader, space, session, rootId: root.body.message.id };
};

describe("a participant whose token has only homileo.spaces.read", () => {
  it("keeps its own read state, notify setting and thread follows", async () => {
    const { reader, session, rootId } = await setup();
    const thread = `${url}/v1/threads/${rootId}`;

    const answers = [
      await fetchJson(
        "PUT",
        `${url}/v1/sessions/${session.id}/read`,
        reader.token,
        {
          seq: 1,
        }
      ),
      await fetchJson(
        "PUT",
        `${url}/v1/sessions/${session.id}/notify`,
        reader.token,
        { notify: "mentions" }
      ),
      await fetchJson("PUT", `${thread}/follow`, reader.token, {
        following: true,
      }),
      await fetchJson("PUT", `${thread}/read`, reader.token, { seq: 1 }),
    ];

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
  });

  it("is refused posting, reacting and removing someone else before the session's own rules run", async () => {
    const { writer, reader, session, rootId } = await setup();

    const answers = [
      await sendMessage(session.id, reader.token, { body: "hello" }),
      await addReaction(rootId, reader.token, "👍"),
      await fetchJson(
        "DELETE",
        `${url}/v1/sessions/${session.id}/participants/${writer.principalId}`,
        reader.token
      ),
    ];

    expect(answers.map((a) => [a.status, a.body.error])).toEqual([
      [403, "forbidden"],
      [403, "forbidden"],
      [403, "forbidden"],
    ]);
  });
});

describe("a member whose token has only homileo.spaces.read", () => {
  it("still leaves a session and its space", async () => {
    const { reader, space, session } = await setup();
    await fixtures.member(space, { id: reader.principalId });

    const leaveSession = await fetchJson(
      "DELETE",
      `${url}/v1/sessions/${session.id}/participants/${reader.principalId}`,
      reader.token
    );
    const leaveSpace = await fetchJson(
      "DELETE",
      `${url}/v1/spaces/${space.id}/members/${reader.principalId}`,
      reader.token
    );

    expect([leaveSession.status, leaveSpace.status]).toEqual([204, 204]);
  });
});

describe("a token with only homileo.chat.admin", () => {
  it("still archives a session and a space", async () => {
    const { space, session } = await setup();
    const admin = await signIn(org, ["homileo.chat.admin"]);

    const sessionArchive = await fetchJson(
      "POST",
      `${url}/v1/sessions/${session.id}/archive`,
      admin.token
    );
    const spaceArchive = await fetchJson(
      "POST",
      `${url}/v1/spaces/${space.id}/archive`,
      admin.token
    );

    expect([sessionArchive.status, spaceArchive.status]).toEqual([200, 200]);
  });
});
