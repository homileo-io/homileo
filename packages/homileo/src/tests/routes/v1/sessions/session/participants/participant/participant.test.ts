// @module-tag int
// @module-tag sessions
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const org = uuidv7();
const url = (s: string, p: string) =>
  `${env.PUBLIC_URL}/v1/sessions/${s}/participants/${p}`;
const row = (sessionId: string, userId: string) =>
  prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("PUT /v1/sessions/:sessionId/participants/:principalId", () => {
  it("joins an open space's space session and makes the caller a space member", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);

    const res = await fetchJson("PUT", url(s.id, me.principalId), me.token);

    expect(res.status).toBe(201);
    expect(res.body.participant).toMatchObject({
      principalId: me.principalId,
      role: "member",
    });
    const member = await prisma.spaceMember.findFirst({
      where: { spaceId: space.id, userId: me.principalId },
    });
    expect(member?.role).toBe("member");
  });

  it("keeps an existing space member a member only once and answers 200 to a repeat", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "request",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);
    await fixtures.member(space, { id: me.principalId });

    expect(
      (await fetchJson("PUT", url(s.id, me.principalId), me.token)).status
    ).toBe(201);
    const again = await fetchJson("PUT", url(s.id, me.principalId), me.token);
    expect(again.status).toBe(200);
    expect(again.body.participant.principalId).toBe(me.principalId);
  });

  it("re-joins after leaving", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);
    await fixtures.participant(s, { id: me.principalId }, "member", {
      left: true,
    });

    const res = await fetchJson("PUT", url(s.id, me.principalId), me.token);

    expect(res.status).toBe(201);
    expect((await row(s.id, me.principalId))?.leftAt).toBeNull();
  });

  it("lets a space-less owner add someone, and answers 200 when they are already in", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    const target = await fixtures.principal();

    const first = await fetchJson("PUT", url(s.id, target.id), owner.token);
    const second = await fetchJson("PUT", url(s.id, target.id), owner.token);

    expect(first.status).toBe(201);
    expect(first.body.participant).toMatchObject({
      principalId: target.id,
      role: "member",
    });
    expect(second.status).toBe(200);
  });

  it("answers 404 to an unknown principal", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");

    const res = await fetchJson("PUT", url(s.id, uuidv7()), owner.token);

    expect(res.status).toBe(404);
  });

  it("requires a space member as target in a space session, with an issue at principalId", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const mod = await signIn(org);
    await fixtures.member(space, { id: mod.principalId }, "moderator");
    const outsider = await fixtures.principal();
    const insider = await fixtures.principal();
    await fixtures.member(space, insider);

    const refused = await fetchJson("PUT", url(s.id, outsider.id), mod.token);
    const added = await fetchJson("PUT", url(s.id, insider.id), mod.token);

    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_request");
    expect(refused.body.issues).toEqual([
      expect.objectContaining({ path: "principalId" }),
    ]);
    expect(added.status).toBe(201);
  });
});

describe("DELETE /v1/sessions/:sessionId/participants/:principalId", () => {
  it("lets a participant leave a group and answers 404 to a repeat", async () => {
    const s = await fixtures.session({ org });
    const me = await signIn(org);
    await fixtures.participant(s, { id: me.principalId }, "owner");
    await fixtures.participant(s, await fixtures.principal(), "owner");

    expect(
      (await fetchJson("DELETE", url(s.id, me.principalId), me.token)).status
    ).toBe(204);
    expect((await row(s.id, me.principalId))?.leftAt).not.toBeNull();
    expect(
      (
        await fetchJson(
          "GET",
          `${env.PUBLIC_URL}/v1/sessions/${s.id}`,
          me.token
        )
      ).status
    ).toBe(404);
  });

  it("answers 404 for a target who is not a current participant", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    const gone = await fixtures.principal();
    await fixtures.participant(s, gone, "member", { left: true });

    expect(
      (await fetchJson("DELETE", url(s.id, gone.id), owner.token)).status
    ).toBe(404);
    expect(
      (await fetchJson("DELETE", url(s.id, uuidv7()), owner.token)).status
    ).toBe(404);
  });

  it("refuses to leave a DM with 403", async () => {
    const a = await signIn(org);
    const b = await signIn(org);
    const dm = await fetchJson(
      "POST",
      `${env.PUBLIC_URL}/v1/sessions/direct`,
      a.token,
      {
        principalId: b.principalId,
      }
    );

    const res = await fetchJson(
      "DELETE",
      url(dm.body.session.id, a.principalId),
      a.token
    );

    expect(res.status).toBe(403);
  });

  it("passes ownership to the earliest-joined participant when the last owner leaves a group", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    const second = await fixtures.principal();
    const third = await fixtures.principal();
    const gone = await fixtures.principal();
    await fixtures.participant(s, gone, "member", { left: true });
    await fixtures.participant(s, second);
    await fixtures.participant(s, third);

    const res = await fetchJson(
      "DELETE",
      url(s.id, owner.principalId),
      owner.token
    );

    expect(res.status).toBe(204);
    expect((await row(s.id, second.id))?.role).toBe("owner");
    expect((await row(s.id, third.id))?.role).toBe("member");
    expect((await row(s.id, gone.id))?.role).toBe("member");
  });

  it("does not promote anyone while another owner remains, or when nobody remains", async () => {
    const s = await fixtures.session({ org });
    const a = await signIn(org);
    const b = await signIn(org);
    const m = await fixtures.principal();
    await fixtures.participant(s, { id: a.principalId }, "owner");
    await fixtures.participant(s, { id: b.principalId }, "owner");
    await fixtures.participant(s, m);

    await fetchJson("DELETE", url(s.id, a.principalId), a.token);
    expect((await row(s.id, m.id))?.role).toBe("member");

    const solo = await fixtures.session({ org });
    await fixtures.participant(solo, { id: a.principalId }, "owner");
    expect(
      (await fetchJson("DELETE", url(solo.id, a.principalId), a.token)).status
    ).toBe(204);
  });

  it("answers 404 to a removed member of a members-only session", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    const member = await signIn(org);
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    await fixtures.participant(s, { id: member.principalId });
    const get = (t: string) =>
      fetchJson("GET", `${env.PUBLIC_URL}/v1/sessions/${s.id}`, t);
    expect((await get(member.token)).status).toBe(200);

    await fetchJson("DELETE", url(s.id, member.principalId), owner.token);

    expect((await get(member.token)).status).toBe(404);
  });

  it("answers 404 to a member removed from a members-only session in a members space", async () => {
    const space = await fixtures.space({ org, visibility: "members" });
    const s = await fixtures.session({ org, space, access: "members" });
    const mod = await signIn(org);
    const member = await signIn(org);
    await fixtures.member(space, { id: mod.principalId }, "moderator");
    await fixtures.member(space, { id: member.principalId });
    await fixtures.participant(s, { id: member.principalId });
    await fixtures.participant(s, { id: mod.principalId });

    const res = await fetchJson(
      "DELETE",
      url(s.id, member.principalId),
      mod.token
    );

    expect(res.status).toBe(204);
    expect(
      (
        await fetchJson(
          "GET",
          `${env.PUBLIC_URL}/v1/sessions/${s.id}`,
          member.token
        )
      ).status
    ).toBe(404);
  });
});
