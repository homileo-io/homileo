// @module-tag int
// @module-tag access
// @module-tag messages
import { removeKinds, provisionKind, startV1App } from "../../support/v1App.js";
import { notificationsTo, sendMessage } from "../../support/messageApi.js";
import { purgeOrganizations, signIn } from "../../support/signedIn.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../support/chatFixtures.js";
import { personToken } from "../../support/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];
let app: Awaited<ReturnType<typeof startV1App>>;

beforeAll(async () => {
  app = await startV1App();
});

afterAll(async () => {
  await app.close();
  await removeKinds();
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

/**
 * A grant moderator who is not a space member starts an `access: members` session in a
 * members-only space, a space owner joins it, and then the grant is gone: the creator is still a
 * participant but can no longer read the session.
 */
const lostRead = async () => {
  const org = uuidv7();
  orgs.push(org);
  fixtures.organization(org);
  const kind = await provisionKind({
    grants: [{ permission: "lost-read.moderate", access: "moderate" }],
  });
  const space = await fixtures.space({ org, kind, visibility: "members" });
  const holder = await signIn(org, [
    "lost-read.moderate",
    "homileo.spaces.write",
  ]);
  const owner = await signIn(org);
  await fixtures.member(space, { id: owner.principalId }, "owner");
  const created = await fetchJson(
    "POST",
    `${app.url}/v1/sessions`,
    holder.token,
    { spaceId: space.id, access: "members" }
  );
  expect(created.status).toBe(201);
  const sessionId: string = created.body.session.id;
  await fixtures.participant({ id: sessionId }, { id: owner.principalId });
  const withoutGrant = personToken({ userId: holder.tereoUserId, org });
  const session = `${app.url}/v1/sessions/${sessionId}`;
  expect((await fetchJson("GET", session, withoutGrant)).status).toBe(404);
  return { holder, owner, sessionId, session, withoutGrant };
};

describe("a participant who cannot read the session's space", () => {
  it("is not stored as mentioned and gets no mention email", async () => {
    const { holder, owner, sessionId } = await lostRead();

    const sent = await sendMessage(
      sessionId,
      owner.token,
      { body: `<@${holder.principalId}> are you there?` },
      app.url
    );

    expect(sent.status).toBe(201);
    const mentions = await prisma.messageMention.findMany({
      where: { messageId: sent.body.message.id },
    });
    expect(mentions).toEqual([]);
    expect(await notificationsTo(holder.tereoUserId)).toEqual([]);
    const listed = await fetchJson(
      "GET",
      `${app.url}/v1/me/mentions`,
      personToken({ userId: holder.tereoUserId, org: owner.org })
    );
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
  });

  it("can still mute the session through its own participant row", async () => {
    const { holder, session, sessionId, withoutGrant } = await lostRead();

    const muted = await fetchJson("PUT", `${session}/notify`, withoutGrant, {
      notify: "none",
    });

    expect(muted.status).toBe(200);
    expect(muted.body.participant.notify).toBe("none");
    const row = await prisma.sessionParticipant.findUniqueOrThrow({
      where: { sessionId_userId: { sessionId, userId: holder.principalId } },
    });
    expect(row.notify).toBe("none");
  });

  it("can still leave the session", async () => {
    const { holder, session, sessionId, withoutGrant } = await lostRead();

    const left = await fetchJson(
      "DELETE",
      `${session}/participants/${holder.principalId}`,
      withoutGrant
    );

    expect(left.status).toBe(204);
    const row = await prisma.sessionParticipant.findUniqueOrThrow({
      where: { sessionId_userId: { sessionId, userId: holder.principalId } },
    });
    expect(row.leftAt).not.toBeNull();
    const again = await fetchJson("PUT", `${session}/notify`, withoutGrant, {
      notify: "all",
    });
    expect(again.status).toBe(404);
  });

  it("still cannot remove someone else, or mute and leave a session it never joined", async () => {
    const { owner, session, withoutGrant } = await lostRead();
    const outsider = personToken({ org: owner.org });

    const removal = await fetchJson(
      "DELETE",
      `${session}/participants/${owner.principalId}`,
      withoutGrant
    );
    const mute = await fetchJson("PUT", `${session}/notify`, outsider, {
      notify: "none",
    });

    expect(removal.status).toBe(404);
    expect(mute.status).toBe(404);
  });
});
