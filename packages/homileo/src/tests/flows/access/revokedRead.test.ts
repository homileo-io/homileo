// @module-tag int
// @module-tag access
// @module-tag auth
import { purgeOrganizations, signIn } from "../../support/signedIn.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { personToken } from "../../support/tokens.js";
import { prisma } from "../../../utils/db/prisma.js";
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

/** A member and participant whose next token has lost every permission. */
const setup = async () => {
  const writer = await signIn(org);
  const member = await signIn(org);
  const space = await fixtures.space({ org, visibility: "members" });
  await fixtures.member(space, { id: writer.principalId }, "owner");
  await fixtures.member(space, { id: member.principalId }, "member");
  const session = await fixtures.session({ org, space, type: "group" });
  await fixtures.participant(session, { id: writer.principalId });
  await fixtures.participant(session, { id: member.principalId });
  const revoked = personToken({
    userId: member.tereoUserId,
    org,
    perms: [],
  });
  return { writer, member, revoked, space, session };
};

describe("a member whose homileo.spaces.read was revoked", () => {
  it("can mute, leave the session and leave the space", async () => {
    const { member, revoked, space, session } = await setup();

    const answers = [
      await fetchJson(
        "PUT",
        `${url}/v1/sessions/${session.id}/notify`,
        revoked,
        { notify: "none" }
      ),
      await fetchJson(
        "DELETE",
        `${url}/v1/sessions/${session.id}/participants/${member.principalId}`,
        revoked
      ),
      await fetchJson(
        "DELETE",
        `${url}/v1/spaces/${space.id}/members/${member.principalId}`,
        revoked
      ),
    ];

    expect(answers.map((a) => a.status)).toEqual([200, 204, 204]);
    expect(
      await prisma.sessionParticipant.findUnique({
        where: {
          sessionId_userId: {
            sessionId: session.id,
            userId: member.principalId,
          },
        },
      })
    ).toMatchObject({ notify: "none", leftAt: expect.any(Date) });
    expect(
      await prisma.spaceMember.findUnique({
        where: {
          spaceId_userId: { spaceId: space.id, userId: member.principalId },
        },
      })
    ).toBeNull();
  });

  it("still cannot read, or remove anyone else", async () => {
    const { writer, revoked, space, session } = await setup();

    const answers = [
      await fetchJson("GET", `${url}/v1/sessions/${session.id}`, revoked),
      await fetchJson(
        "GET",
        `${url}/v1/sessions/${session.id}/participants`,
        revoked
      ),
      await fetchJson(
        "DELETE",
        `${url}/v1/sessions/${session.id}/participants/${writer.principalId}`,
        revoked
      ),
      await fetchJson(
        "DELETE",
        `${url}/v1/spaces/${space.id}/members/${writer.principalId}`,
        revoked
      ),
    ];

    expect(answers.map((a) => [a.status, a.body.error_description])).toEqual(
      Array(4).fill([403, "Requires the homileo.spaces.read permission"])
    );
  });
});
