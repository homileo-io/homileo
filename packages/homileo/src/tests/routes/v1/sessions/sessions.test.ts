// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../support/signedIn.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../../support/chatFixtures.js";
import { personToken } from "../../../support/tokens.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  removeKinds,
  provisionKind,
  startV1App,
} from "../../../support/v1App.js";

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

describe("POST /v1/sessions in a space", () => {
  it("makes the creator a member and keeps access `space` by default", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", URL, me.token, {
      spaceId: space.id,
      name: "Case 1",
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      spaceId: space.id,
      type: "group",
      access: "space",
      name: "Case 1",
      createdBy: me.principalId,
    });
    const rows = await prisma.sessionParticipant.findMany({
      where: { sessionId: res.body.session.id },
    });
    expect(rows.map((r) => [r.userId, r.role])).toEqual([
      [me.principalId, "member"],
    ]);
  });

  it("adds participants who are members of the space", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const other = await signIn(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });
    await fixtures.member(space, { id: other.principalId });

    const res = await fetchJson("POST", URL, me.token, {
      spaceId: space.id,
      participantIds: [other.principalId],
    });

    expect(res.status).toBe(201);
    const rows = await prisma.sessionParticipant.findMany({
      where: { sessionId: res.body.session.id },
    });
    expect(rows.map((r) => r.userId).sort()).toEqual(
      [me.principalId, other.principalId].sort()
    );
  });

  it("refuses a participant who is not a member, naming the id", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const member = await signIn(org);
    const outsider = await signIn(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });
    await fixtures.member(space, { id: member.principalId });

    const res = await fetchJson("POST", URL, me.token, {
      spaceId: space.id,
      participantIds: [member.principalId, outsider.principalId],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.issues).toEqual([
      expect.objectContaining({ path: "participantIds.1" }),
    ]);
    expect(await prisma.session.count({ where: { organizationId: org } })).toBe(
      0
    );
  });

  it("refuses an unknown principal id with 400", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", URL, me.token, {
      spaceId: space.id,
      participantIds: [uuidv7()],
    });

    expect(res.status).toBe(400);
    expect(res.body.issues[0].path).toBe("participantIds.0");
  });

  it("refuses a member in a space where posting is for moderators", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, postPolicy: "moderators" });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("posting_restricted");
  });

  it("lets a moderator create in a moderators-only space", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, postPolicy: "moderators" });
    await fixtures.member(space, { id: me.principalId }, "moderator");

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(201);
  });

  it("answers 403 to a reader who is not a member of a public space", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, visibility: "public" });

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(403);
  });

  it("answers 404 for a space the caller cannot read", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org });

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(404);
  });

  it("answers 404 for a space in another organization", async () => {
    const me = await signIn(newOrg());
    const space = await fixtures.space({ visibility: "public" });

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(404);
  });

  it("answers 409 resource_archived for an archived space", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, archived: true });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", URL, me.token, { spaceId: space.id });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });

  it("stores the access the caller asks for", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", URL, me.token, {
      spaceId: space.id,
      access: "members",
      externalRef: "case-9",
      metadata: { priority: "high" },
    });

    expect(res.body.session).toMatchObject({
      access: "members",
      externalRef: "case-9",
      metadata: { priority: "high" },
    });
  });
});

describe("POST /v1/sessions with a kind", () => {
  let app: Awaited<ReturnType<typeof startV1App>>;
  beforeAll(async () => {
    app = await startV1App();
  });
  afterAll(async () => {
    await app.close();
    await removeKinds();
  });

  it("adds the kind's bots as space members and participants", async () => {
    const org = newOrg();
    const botUser = uuidv7();
    const kind = await provisionKind({ bots: [botUser] });
    const me = await signIn(org);
    const space = await fixtures.space({ org, kind });
    await fixtures.member(space, { id: me.principalId });

    const res = await fetchJson("POST", `${app.url}/v1/sessions`, me.token, {
      spaceId: space.id,
    });

    expect(res.status).toBe(201);
    const bot = await prisma.principal.findUniqueOrThrow({
      where: { tereoUserId: botUser },
    });
    expect(bot.isBot).toBe(true);
    const participant = await prisma.sessionParticipant.findUnique({
      where: {
        sessionId_userId: { sessionId: res.body.session.id, userId: bot.id },
      },
    });
    expect(participant?.role).toBe("member");
    const membership = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: space.id, userId: bot.id } },
    });
    expect(membership?.role).toBe("member");
    const events = await prisma.event.findMany({
      where: { organizationId: org, type: "space.member_added" },
    });
    expect(events).toHaveLength(1);
  });

  it("does not add a bot that is already a member twice", async () => {
    const org = newOrg();
    const botUser = uuidv7();
    const kind = await provisionKind({ bots: [botUser] });
    const me = await signIn(org);
    const space = await fixtures.space({ org, kind });
    await fixtures.member(space, { id: me.principalId });

    await fetchJson("POST", `${app.url}/v1/sessions`, me.token, {
      spaceId: space.id,
    });
    await fetchJson("POST", `${app.url}/v1/sessions`, me.token, {
      spaceId: space.id,
    });

    const added = await prisma.event.count({
      where: { organizationId: org, type: "space.member_added" },
    });
    expect(added).toBe(1);
  });

  it("validates state against the kind's states", async () => {
    const org = newOrg();
    const kind = await provisionKind({ states: ["open", "closed"] });
    const me = await signIn(org);
    const space = await fixtures.space({ org, kind });
    await fixtures.member(space, { id: me.principalId });

    const bad = await fetchJson("POST", `${app.url}/v1/sessions`, me.token, {
      spaceId: space.id,
      state: "pending",
    });
    const good = await fetchJson("POST", `${app.url}/v1/sessions`, me.token, {
      spaceId: space.id,
      state: "open",
    });

    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_state");
    expect(good.status).toBe(201);
    expect(good.body.session.state).toBe("open");
  });
});

describe("POST /v1/sessions without a space", () => {
  it("rejects a JSON body over 256 KiB with 413 payload_too_large", async () => {
    const me = await signIn(newOrg());

    const res = await fetchJson("POST", URL, me.token, {
      name: "x".repeat(300 * 1024),
    });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("makes the creator the owner and the others members, storing access `members`", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const other = await signIn(org);

    const res = await fetchJson("POST", URL, me.token, {
      name: "Friends",
      access: "space",
      participantIds: [other.principalId],
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      spaceId: null,
      type: "group",
      access: "members",
    });
    const rows = await prisma.sessionParticipant.findMany({
      where: { sessionId: res.body.session.id },
    });
    expect(Object.fromEntries(rows.map((r) => [r.userId, r.role]))).toEqual({
      [me.principalId]: "owner",
      [other.principalId]: "member",
    });
  });

  it("treats an upper-case copy of the creator's id as the creator", async () => {
    const me = await signIn(newOrg());

    const res = await fetchJson("POST", URL, me.token, {
      participantIds: [me.principalId.toUpperCase()],
    });

    expect(res.status).toBe(201);
  });

  it("does not add the creator twice when they list themselves", async () => {
    const me = await signIn(newOrg());

    const res = await fetchJson("POST", URL, me.token, {
      participantIds: [me.principalId],
    });

    expect(res.status).toBe(201);
    expect(
      await prisma.sessionParticipant.count({
        where: { sessionId: res.body.session.id },
      })
    ).toBe(1);
  });
});

describe("GET /v1/sessions", () => {
  it("lists the sessions the caller participates in, with their participant", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const mine = await fixtures.session({ org });
    await fixtures.participant(mine, { id: me.principalId }, "owner");
    const left = await fixtures.session({ org });
    await fixtures.participant(left, { id: me.principalId }, "member", {
      left: true,
    });
    await fixtures.session({ org });
    const otherOrg = await fixtures.session({ org: newOrg() });
    await fixtures.participant(otherOrg, { id: me.principalId });

    const res = await fetchJson("GET", URL, me.token);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    expect(res.body.data[0].participant).toMatchObject({
      principalId: me.principalId,
      role: "owner",
      sessionId: mine.id,
    });
  });

  it("filters by type and hides archived sessions unless asked", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const group = await fixtures.session({ org });
    const archived = await fixtures.session({ org, archived: true });
    for (const s of [group, archived]) {
      await fixtures.participant(s, { id: me.principalId });
    }

    const plain = await fetchJson("GET", URL, me.token);
    const withArchived = await fetchJson(
      "GET",
      `${URL}?includeArchived=true`,
      me.token
    );
    const direct = await fetchJson(
      "GET",
      `${URL}?includeArchived=true&type=direct`,
      me.token
    );

    expect(plain.body.data.map((s: { id: string }) => s.id)).toEqual([
      group.id,
    ]);
    expect(
      withArchived.body.data.map((s: { id: string }) => s.id).sort()
    ).toEqual([group.id, archived.id].sort());
    expect(direct.body.data).toEqual([]);
  });

  it("sorts sessions with messages first, then by creation, newest first", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await fixtures.session({ org });
      await fixtures.participant(s, { id: me.principalId });
      ids.push(s.id);
    }
    await prisma.session.update({
      where: { id: ids[0] },
      data: { lastMessageAt: new Date(Date.now() - 60_000) },
    });
    await prisma.session.update({
      where: { id: ids[1] },
      data: { lastMessageAt: new Date() },
    });

    const res = await fetchJson("GET", URL, me.token);

    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([
      ids[1],
      ids[0],
      ids[3],
      ids[2],
    ]);
  });

  it("lists a space's sessions by what the caller can read", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const open = await fixtures.session({ org, space, access: "space" });
    const hidden = await fixtures.session({ org, space, access: "members" });
    const joined = await fixtures.session({ org, space, access: "members" });
    await fixtures.participant(joined, { id: me.principalId });

    const res = await fetchJson("GET", `${URL}?spaceId=${space.id}`, me.token);

    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids.sort()).toEqual([open.id, joined.id].sort());
    expect(ids).not.toContain(hidden.id);
    const byId = Object.fromEntries(
      res.body.data.map((s: { id: string; participant: unknown }) => [
        s.id,
        s.participant,
      ])
    );
    expect(byId[open.id]).toBeNull();
    expect(byId[joined.id]).not.toBeNull();
  });

  it("lists every session of a space to an admin, but never a DM or space-less one", async () => {
    const org = newOrg();
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const space = await fixtures.space({ org, visibility: "public" });
    const members = await fixtures.session({ org, space, access: "members" });
    const loose = await fixtures.session({ org });

    const inSpace = await fetchJson(
      "GET",
      `${URL}?spaceId=${space.id}`,
      admin.token
    );
    const mine = await fetchJson("GET", URL, admin.token);

    expect(inSpace.body.data.map((s: { id: string }) => s.id)).toEqual([
      members.id,
    ]);
    expect(mine.body.data.map((s: { id: string }) => s.id)).not.toContain(
      loose.id
    );
  });

  it("answers 404 for a space the caller cannot read", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org });

    const res = await fetchJson("GET", `${URL}?spaceId=${space.id}`, me.token);

    expect(res.status).toBe(404);
  });

  it("finds sessions by externalRef across organizations' limits, through the read check", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const ref = `ref-${uuidv7()}`;
    const visible = await fixtures.session({ org });
    const invisible = await fixtures.session({ org });
    const foreign = await fixtures.session({ org: newOrg() });
    await fixtures.participant(visible, { id: me.principalId });
    for (const s of [visible, invisible, foreign]) {
      await prisma.session.update({
        where: { id: s.id },
        data: { externalRef: ref },
      });
    }

    const res = await fetchJson("GET", `${URL}?externalRef=${ref}`, me.token);

    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([
      visible.id,
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns the readable match with limit=1 when an unreadable one comes first", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const ref = `ref-${uuidv7()}`;
    const invisible = await fixtures.session({ org });
    const visible = await fixtures.session({ org });
    await fixtures.participant(visible, { id: me.principalId });
    await prisma.session.update({
      where: { id: invisible.id },
      data: { externalRef: ref, lastMessageAt: new Date() },
    });
    await prisma.session.update({
      where: { id: visible.id },
      data: { externalRef: ref },
    });

    const res = await fetchJson(
      "GET",
      `${URL}?externalRef=${ref}&limit=1`,
      me.token
    );

    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([
      visible.id,
    ]);
  });

  it("filters a space's list by externalRef", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const a = await fixtures.session({ org, space, access: "space" });
    await fixtures.session({ org, space, access: "space" });
    await prisma.session.update({
      where: { id: a.id },
      data: { externalRef: "only-a" },
    });

    const res = await fetchJson(
      "GET",
      `${URL}?spaceId=${space.id}&externalRef=only-a`,
      me.token
    );

    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([a.id]);
  });
});

describe("GET /v1/sessions with a kind grant", () => {
  let app: Awaited<ReturnType<typeof startV1App>>;
  beforeAll(async () => {
    app = await startV1App();
  });
  afterAll(async () => {
    await app.close();
    await removeKinds();
  });

  it("lists the members-only sessions of a space to a grant holder", async () => {
    const org = newOrg();
    const kind = await provisionKind({
      grants: [{ permission: "sessions-test.read", access: "read" }],
    });
    const holder = await signIn(org, ["sessions-test.read"]);
    const space = await fixtures.space({ org, kind, visibility: "public" });
    const members = await fixtures.session({ org, space, access: "members" });

    const res = await fetchJson(
      "GET",
      `${app.url}/v1/sessions?spaceId=${space.id}`,
      holder.token
    );

    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([
      members.id,
    ]);
  });

  it("drops a session the caller still participates in but can no longer read", async () => {
    const org = newOrg();
    const kind = await provisionKind({
      grants: [{ permission: "sessions-test.moderate", access: "moderate" }],
    });
    const holder = await signIn(org, ["sessions-test.moderate"]);
    const space = await fixtures.space({ org, kind, visibility: "members" });
    const created = await fetchJson(
      "POST",
      `${app.url}/v1/sessions`,
      holder.token,
      { spaceId: space.id }
    );
    expect(created.status).toBe(201);
    const ids = (body: { data: Array<{ id: string }> }) =>
      body.data.map((s) => s.id);
    const before = await fetchJson(
      "GET",
      `${app.url}/v1/sessions`,
      holder.token
    );
    expect(ids(before.body)).toEqual([created.body.session.id]);

    const withoutGrant = personToken({ userId: holder.tereoUserId, org });
    const after = await fetchJson(
      "GET",
      `${app.url}/v1/sessions`,
      withoutGrant
    );

    expect(after.status).toBe(200);
    expect(ids(after.body)).toEqual([]);
    expect(after.body.nextCursor).toBeNull();
  });
});
