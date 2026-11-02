// @module-tag int
// @module-tag auth
// @module-tag security
import { purgeOrganizations, signIn } from "../support/signedIn.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "../support/http.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../env.js";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const organization = () => {
  const org = uuidv7();
  orgs.push(org);
  fixtures.organization(org);
  return org;
};

/** A token without permissions and its principal, which `/v1/me` would refuse to say. */
const unreadable = async (org: string) => {
  const userId = uuidv7();
  const token = personToken({ userId, org, perms: [] });
  await fetch(`${env.PUBLIC_URL}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const principal = await prisma.principal.findUniqueOrThrow({
    where: { tereoUserId: userId },
  });
  return { token, principalId: principal.id };
};

const call = async (method: string, path: string, token: string) => {
  const response = await fetch(`${env.PUBLIC_URL}/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: method === "PUT" ? JSON.stringify({ notify: "none" }) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const PLAIN_404 = {
  status: 404,
  body: { error: "not_found", error_description: "Not found" },
};

describe("own-only routes for a caller without homileo.spaces.read", () => {
  const leaveSpace = (spaceId: string, principalId: string) =>
    ["DELETE", `/spaces/${spaceId}/members/${principalId}`] as const;
  const leaveSession = (sessionId: string, principalId: string) =>
    ["DELETE", `/sessions/${sessionId}/participants/${principalId}`] as const;
  const mute = (sessionId: string) =>
    ["PUT", `/sessions/${sessionId}/notify`] as const;

  it("refuses every leave of a space with the same plain 404", async () => {
    const org = organization();
    const me = await unreadable(org);
    const publicSpace = await fixtures.space({ org, visibility: "public" });
    const owned = await fixtures.space({ org });
    await fixtures.member(owned, { id: me.principalId }, "owner");
    const elsewhere = await fixtures.space({ visibility: "public" });

    for (const spaceId of [uuidv7(), publicSpace.id, owned.id, elsewhere.id]) {
      const [method, path] = leaveSpace(spaceId, me.principalId);
      expect(await call(method, path, me.token), spaceId).toEqual(PLAIN_404);
    }
  });

  it("refuses every leave of a session with the same plain 404", async () => {
    const org = organization();
    const me = await unreadable(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ space, access: "space" });
    const peer = await signIn(org);
    const direct = await fetchJson(
      "POST",
      `${env.PUBLIC_URL}/v1/sessions/direct`,
      peer.token,
      { principalId: me.principalId }
    );
    expect(direct.status).toBe(201);

    for (const sessionId of [uuidv7(), open.id, direct.body.session.id]) {
      const [method, path] = leaveSession(sessionId, me.principalId);
      expect(await call(method, path, me.token), sessionId).toEqual(PLAIN_404);
    }
  });

  it("refuses every mute with the same plain 404", async () => {
    const org = organization();
    const me = await unreadable(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ space, access: "space" });

    for (const sessionId of [uuidv7(), open.id]) {
      const [method, path] = mute(sessionId);
      expect(await call(method, path, me.token), sessionId).toEqual(PLAIN_404);
    }
  });

  it("still leaves and mutes what the caller is in", async () => {
    const org = organization();
    const me = await unreadable(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });
    const session = await fixtures.session({ space, access: "members" });
    await fixtures.participant(session, { id: me.principalId });

    expect((await call(...mute(session.id), me.token)).status).toBe(200);
    expect(
      (await call(...leaveSession(session.id, me.principalId), me.token)).status
    ).toBe(204);
    expect(
      (await call(...leaveSpace(space.id, me.principalId), me.token)).status
    ).toBe(204);
  });

  it("still tells a reader why it was refused", async () => {
    const org = organization();
    const me = await signIn(org, ["homileo.spaces.read"]);
    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ space, access: "space" });

    expect(
      (await call(...leaveSpace(space.id, me.principalId), me.token)).body
    ).toMatchObject({ error_description: "Member not found" });
    expect(
      (await call(...leaveSession(open.id, me.principalId), me.token)).body
    ).toMatchObject({ error_description: "Participant not found" });
    expect((await call(...mute(open.id), me.token)).body).toMatchObject({
      error: "not_a_participant",
    });
  });
});
