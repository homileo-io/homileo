// @module-tag int
// @module-tag sessions
// @module-tag access
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../support/http.js";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  removeKinds,
  provisionKind,
  startV1App,
} from "../../../../support/v1App.js";

const URL = `${env.PUBLIC_URL}/v1/sessions`;
const fixtures = chatFixtures();
const orgs: string[] = [];
const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

afterAll(async () => {
  await purgeOrganizations(orgs);
  await fixtures.cleanup();
});

describe("reading a members-only session in a public space", () => {
  let app: Awaited<ReturnType<typeof startV1App>>;
  beforeAll(async () => {
    app = await startV1App();
  });
  afterAll(async () => {
    await app.close();
    await removeKinds();
  });

  it("answers 404 to a non-participant, 200 to a participant, a grant holder and an admin", async () => {
    const org = newOrg();
    const kind = await provisionKind({
      grants: [{ permission: "sessions-perm.read", access: "read" }],
    });
    const space = await fixtures.space({ org, kind, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "members" });
    const outsider = await signIn(org);
    const participant = await signIn(org);
    const holder = await signIn(org, ["sessions-perm.read"]);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    await fixtures.participant(s, { id: participant.principalId });

    const status = async (who: { token: string }) =>
      (await fetchJson("GET", `${app.url}/v1/sessions/${s.id}`, who.token))
        .status;

    expect(await status(outsider)).toBe(404);
    expect(await status(participant)).toBe(200);
    expect(await status(holder)).toBe(200);
    expect(await status(admin)).toBe(200);
  });
});

describe("PATCH /v1/sessions/:sessionId permissions", () => {
  const patch = (id: string, token: string) =>
    fetchJson("PATCH", `${URL}/${id}`, token, { name: "new" });

  it("lets a space moderator edit and refuses a plain member with 403", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const moderator = await signIn(org);
    const member = await signIn(org);
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.member(space, { id: member.principalId });

    expect((await patch(s.id, moderator.token)).status).toBe(200);
    expect((await patch(s.id, member.token)).status).toBe(403);
  });

  it("lets only the owner of a space-less group edit", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    const member = await signIn(org);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    await fixtures.participant(s, { id: member.principalId });

    expect((await patch(s.id, owner.token)).status).toBe(200);
    expect((await patch(s.id, member.token)).status).toBe(403);
    expect((await patch(s.id, admin.token)).status).toBe(404);
  });

  it("refuses to edit a DM with 403", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const b = await signIn(org);
    const dm = await fetchJson("POST", `${URL}/direct`, a.token, {
      principalId: b.principalId,
    });

    expect((await patch(dm.body.session.id, a.token)).status).toBe(403);
  });

  it("answers 404 to a participant who left and to another organization", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const left = await signIn(org);
    const foreign = await signIn(newOrg());
    await fixtures.participant(s, { id: left.principalId }, "owner", {
      left: true,
    });
    await fixtures.participant(s, { id: foreign.principalId }, "owner");

    expect((await patch(s.id, left.token)).status).toBe(404);
    expect((await patch(s.id, foreign.token)).status).toBe(404);
  });
});
