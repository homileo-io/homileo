// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

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

const archive = (id: string, token: string) =>
  fetchJson("POST", `${URL}/${id}/archive`, token);

describe("POST /v1/sessions/:sessionId/archive", () => {
  it("archives a session and keeps it readable", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");

    const res = await archive(s.id, me.token);

    expect(res.status).toBe(200);
    expect(res.body.session.archivedAt).toEqual(expect.any(String));
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.archivedAt).not.toBeNull();
    const read = await fetchJson("GET", `${URL}/${s.id}`, me.token);
    expect(read.status).toBe(200);
  });

  it("answers 409 already_archived the second time", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    await archive(s.id, me.token);

    const res = await archive(s.id, me.token);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_archived");
  });

  it("in a space, lets a moderator archive and refuses a member with 403", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org, visibility: "public" });
    const mine = await fixtures.session({ org, space, access: "space" });
    const moderator = await signIn(org);
    const member = await signIn(org);
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.member(space, { id: member.principalId });

    expect((await archive(mine.id, member.token)).status).toBe(403);
    expect((await archive(mine.id, moderator.token)).status).toBe(200);
  });

  it("in a space-less group, lets the owner or an admin archive, not a member", async () => {
    const org = newOrg();
    const owner = await signIn(org);
    const member = await signIn(org);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const a = await fixtures.session({ org });
    const b = await fixtures.session({ org });
    for (const s of [a, b]) {
      await fixtures.participant(s, { id: owner.principalId }, "owner");
      await fixtures.participant(s, { id: member.principalId });
    }
    await fixtures.participant(b, { id: admin.principalId });

    expect((await archive(a.id, member.token)).status).toBe(403);
    expect((await archive(a.id, owner.token)).status).toBe(200);
    expect((await archive(b.id, admin.token)).status).toBe(200);
  });

  it("archives a DM only for homileo.chat.admin", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const dm = await fetchJson("POST", `${URL}/direct`, a.token, {
      principalId: admin.principalId,
    });

    expect((await archive(dm.body.session.id, a.token)).status).toBe(403);
    expect((await archive(dm.body.session.id, admin.token)).status).toBe(200);
  });

  it("lets an admin who is not in a DM archive it, still without reading it", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const b = await signIn(org);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const foreignAdmin = await signIn(newOrg(), ["homileo.chat.admin"]);
    const dm = await fetchJson("POST", `${URL}/direct`, a.token, {
      principalId: b.principalId,
    });
    const id = dm.body.session.id;

    expect((await archive(id, foreignAdmin.token)).status).toBe(404);
    expect((await archive(id, admin.token)).status).toBe(200);
    expect((await fetchJson("GET", `${URL}/${id}`, admin.token)).status).toBe(
      404
    );
    expect(
      (await fetchJson("GET", `${URL}/${id}/messages`, admin.token)).status
    ).toBe(404);
  });

  it("answers 404 for a session in another organization or one the caller cannot read", async () => {
    const me = await signIn(newOrg());
    const foreign = await fixtures.session({ org: newOrg() });
    await fixtures.participant(foreign, { id: me.principalId }, "owner");

    expect((await archive(foreign.id, me.token)).status).toBe(404);
    expect((await archive(uuidv7(), me.token)).status).toBe(404);
    expect((await archive("nope", me.token)).status).toBe(400);
  });
});
