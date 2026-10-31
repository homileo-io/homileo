// @module-tag int
// @module-tag sessions
// @module-tag access
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { fetchJson } from "../../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const orgs: string[] = [];
const newOrg = () => {
  const o = uuidv7();
  orgs.push(o);
  return o;
};
const url = (s: string, p: string) =>
  `${env.PUBLIC_URL}/v1/sessions/${s}/participants/${p}`;

afterAll(async () => {
  await purgeOrganizations(orgs);
  await fixtures.cleanup();
});

describe("participant permissions", () => {
  it("refuses a join to a non-member of a request space with 403", async () => {
    const org = newOrg();
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "request",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);

    expect(
      (await fetchJson("PUT", url(s.id, me.principalId), me.token)).status
    ).toBe(403);
  });

  it("refuses to join a members-only session even to a readable one", async () => {
    const org = newOrg();
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
    });
    const s = await fixtures.session({ org, space, access: "members" });
    const admin = await signIn(org, ["homileo.chat.admin"]);

    expect(
      (await fetchJson("PUT", url(s.id, admin.principalId), admin.token)).status
    ).toBe(403);
  });

  it("lets a space-less owner add and refuses a plain member with 403", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    const member = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    await fixtures.participant(s, { id: member.principalId });
    const target = await fixtures.principal();

    expect(
      (await fetchJson("PUT", url(s.id, target.id), member.token)).status
    ).toBe(403);
    expect(
      (await fetchJson("PUT", url(s.id, target.id), owner.token)).status
    ).toBe(201);
  });

  it("refuses an add to a DM with 403, even for an admin", async () => {
    const org = newOrg();
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const b = await signIn(org);
    const dm = await fetchJson(
      "POST",
      `${env.PUBLIC_URL}/v1/sessions/direct`,
      admin.token,
      {
        principalId: b.principalId,
      }
    );
    const third = await fixtures.principal();

    expect(
      (await fetchJson("PUT", url(dm.body.session.id, third.id), admin.token))
        .status
    ).toBe(403);
  });

  it("lets an admin who participates remove from a space-less group, and refuses a member with 403", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const member = await signIn(org);
    const victim = await fixtures.principal();
    await fixtures.participant(s, { id: admin.principalId });
    await fixtures.participant(s, { id: member.principalId });
    await fixtures.participant(s, victim);

    expect(
      (await fetchJson("DELETE", url(s.id, victim.id), member.token)).status
    ).toBe(403);
    expect(
      (await fetchJson("DELETE", url(s.id, victim.id), admin.token)).status
    ).toBe(204);
  });

  it("lets an admin who is not a participant remove from a space-less group, still without reading it", async () => {
    const org = newOrg();
    const s = await fixtures.session({ org });
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const victim = await fixtures.principal();
    await fixtures.participant(s, victim);
    const sessionUrl = `${env.PUBLIC_URL}/v1/sessions/${s.id}`;

    expect(
      (await fetchJson("PUT", url(s.id, admin.principalId), admin.token)).status
    ).toBe(404);
    expect(
      (await fetchJson("DELETE", url(s.id, victim.id), admin.token)).status
    ).toBe(204);
    expect((await fetchJson("GET", sessionUrl, admin.token)).status).toBe(404);
    expect(
      (await fetchJson("GET", `${sessionUrl}/messages`, admin.token)).status
    ).toBe(404);
  });

  it("lets a space moderator remove from a space session and refuses a plain member", async () => {
    const org = newOrg();
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const mod = await signIn(org);
    const member = await signIn(org);
    const victim = await fixtures.principal();
    await fixtures.member(space, { id: mod.principalId }, "moderator");
    await fixtures.member(space, { id: member.principalId });
    await fixtures.participant(s, { id: member.principalId });
    await fixtures.participant(s, victim);

    expect(
      (await fetchJson("DELETE", url(s.id, victim.id), member.token)).status
    ).toBe(403);
    expect(
      (await fetchJson("DELETE", url(s.id, victim.id), mod.token)).status
    ).toBe(204);
  });

  it("refuses adds, joins and removals in an archived session or space with 409 resource_archived, but not leaving", async () => {
    const org = newOrg();
    const archivedSpace = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
      archived: true,
    });
    const inArchivedSpace = await fixtures.session({
      org,
      space: archivedSpace,
      access: "space",
    });
    const archivedGroup = await fixtures.session({ org, archived: true });
    const owner = await signIn(org);
    const member = await signIn(org);
    const joiner = await signIn(org);
    const victim = await fixtures.principal();
    await fixtures.member(archivedSpace, { id: owner.principalId }, "owner");
    await fixtures.member(archivedSpace, { id: member.principalId });
    for (const s of [inArchivedSpace, archivedGroup]) {
      await fixtures.participant(s, { id: owner.principalId }, "owner");
      await fixtures.participant(s, { id: member.principalId });
      await fixtures.participant(s, victim);
    }
    const target = await fixtures.principal();
    await fixtures.member(archivedSpace, target);

    const refused = [
      await fetchJson("PUT", url(archivedGroup.id, target.id), owner.token),
      await fetchJson("DELETE", url(archivedGroup.id, victim.id), owner.token),
      await fetchJson("PUT", url(inArchivedSpace.id, target.id), owner.token),
      await fetchJson(
        "PUT",
        url(inArchivedSpace.id, joiner.principalId),
        joiner.token
      ),
      await fetchJson(
        "DELETE",
        url(inArchivedSpace.id, victim.id),
        owner.token
      ),
    ];
    for (const res of refused) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("resource_archived");
    }
    for (const s of [archivedGroup, inArchivedSpace]) {
      expect(
        (await fetchJson("DELETE", url(s.id, member.principalId), member.token))
          .status
      ).toBe(204);
    }
  });

  it("answers 404 across organizations", async () => {
    const s = await fixtures.session({ org: newOrg() });
    const foreign = await signIn(newOrg());
    await fixtures.participant(s, { id: foreign.principalId }, "owner");

    expect(
      (await fetchJson("DELETE", url(s.id, foreign.principalId), foreign.token))
        .status
    ).toBe(404);
  });
});
