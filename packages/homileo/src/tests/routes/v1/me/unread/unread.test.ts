// @module-tag int
// @module-tag auth
// @module-tag sessions
// @module-tag messages
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { seedMessages } from "../../../../support/unreadFixtures.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const seed = seedMessages();
const orgs: string[] = [];
const UNREAD = `${env.PUBLIC_URL}/v1/me/unread`;

afterAll(async () => {
  await seed.cleanup();
  await purgeOrganizations(orgs);
  await fixtures.cleanup();
});

const setup = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const other = await fixtures.principal();
  const s = await fixtures.session({ org });
  await fixtures.participant(s, { id: me.principalId });
  await fixtures.participant(s, other);
  return { org, me, other, s };
};

const get = (token: string) => fetchJson("GET", UNREAD, token);
const sessionEntry = (
  body: { sessions: Array<{ sessionId: string; [k: string]: unknown }> },
  id: string
) => body.sessions.find((e) => e.sessionId === id);

describe("GET /v1/me/unread", () => {
  it("answers 401 without a token", async () => {
    expect((await fetchJson("GET", UNREAD, null)).status).toBe(401);
  });

  it("counts top-level messages only, never the caller's own", async () => {
    const { me, other, s } = await setup();
    await seed.many(s.id, other.id, 3);
    const root = await seed.add(s.id, other.id);
    await seed.add(s.id, other.id, { threadRootId: root.id });
    await seed.add(s.id, other.id, { threadRootId: root.id });
    await seed.add(s.id, me.principalId);
    await seed.add(s.id, other.id, { deleted: true });

    const res = await get(me.token);

    expect(res.status).toBe(200);
    expect(sessionEntry(res.body, s.id)).toEqual({
      sessionId: s.id,
      unread: 4,
      unreadCapped: false,
      mentions: 0,
      lastSeq: 8,
      lastReadSeq: 0,
    });
  });

  it("caps at 99 and says so", async () => {
    const { me, other, s } = await setup();
    await seed.many(s.id, other.id, 120);

    const entry = sessionEntry((await get(me.token)).body, s.id);

    expect(entry).toMatchObject({
      unread: 99,
      unreadCapped: true,
      lastSeq: 120,
    });
  });

  it("is cleared by PUT read", async () => {
    const { me, other, s } = await setup();
    await seed.many(s.id, other.id, 3);
    expect(sessionEntry((await get(me.token)).body, s.id).unread).toBe(3);

    await fetchJson(
      "PUT",
      `${env.PUBLIC_URL}/v1/sessions/${s.id}/read`,
      me.token,
      { seq: 3 }
    );

    expect(sessionEntry((await get(me.token)).body, s.id)).toBeUndefined();
  });

  it("counts mentions of the caller and here/session, but not of others or the caller's own", async () => {
    const { me, other, s } = await setup();
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });
    await seed.add(s.id, other.id, { mentions: [{ kind: "here" }] });
    await seed.add(s.id, other.id, { mentions: [{ kind: "session" }] });
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: other.id }],
    });
    await seed.add(s.id, other.id, {
      deleted: true,
      mentions: [{ kind: "here" }],
    });
    await seed.add(s.id, me.principalId, { mentions: [{ kind: "here" }] });

    const entry = sessionEntry((await get(me.token)).body, s.id);

    expect(entry.mentions).toBe(3);
    expect(entry.unread).toBe(4);
  });

  it("counts a message with a user and a here mention once", async () => {
    const { me, other, s } = await setup();
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }, { kind: "here" }],
    });

    expect(sessionEntry((await get(me.token)).body, s.id).mentions).toBe(1);
  });

  it("counts a mention in a reply, which is not a top-level unread", async () => {
    const { me, other, s } = await setup();
    const root = await seed.add(s.id, me.principalId);
    await seed.add(s.id, other.id, {
      threadRootId: root.id,
      mentions: [{ kind: "user", userId: me.principalId }],
    });

    const entry = sessionEntry((await get(me.token)).body, s.id);

    expect(entry).toMatchObject({ unread: 0, mentions: 1 });
  });

  it("leaves out sessions with nothing unread", async () => {
    const { me, s } = await setup();

    expect(sessionEntry((await get(me.token)).body, s.id)).toBeUndefined();
  });

  it("lists a followed thread with a new reply, and drops it once unfollowed", async () => {
    const { me, other, s } = await setup();
    const root = await seed.add(s.id, me.principalId);
    await prisma.threadFollower.create({
      data: { threadRootId: root.id, userId: me.principalId, lastReadSeq: 1n },
    });
    await seed.add(s.id, other.id, { threadRootId: root.id });
    await seed.add(s.id, me.principalId, { threadRootId: root.id });

    const first = (await get(me.token)).body;

    expect(first.threads).toEqual([
      { rootId: root.id, sessionId: s.id, unread: 1, unreadCapped: false },
    ]);

    await prisma.threadFollower.update({
      where: {
        threadRootId_userId: { threadRootId: root.id, userId: me.principalId },
      },
      data: { following: false },
    });

    expect((await get(me.token)).body.threads).toEqual([]);
  });

  it("caps thread unread at 99", async () => {
    const { me, other, s } = await setup();
    const root = await seed.add(s.id, me.principalId);
    await prisma.threadFollower.create({
      data: { threadRootId: root.id, userId: me.principalId, lastReadSeq: 1n },
    });
    for (let i = 0; i < 101; i++) {
      await seed.add(s.id, other.id, { threadRootId: root.id });
    }

    const thread = (await get(me.token)).body.threads[0];

    expect(thread).toMatchObject({ unread: 99, unreadCapped: true });
  });

  it("omits sessions the caller has left, and their threads", async () => {
    const { me, other, s } = await setup();
    const root = await seed.add(s.id, other.id);
    await prisma.threadFollower.create({
      data: { threadRootId: root.id, userId: me.principalId },
    });
    await seed.add(s.id, other.id, { threadRootId: root.id });
    await prisma.sessionParticipant.update({
      where: {
        sessionId_userId: { sessionId: s.id, userId: me.principalId },
      },
      data: { leftAt: new Date() },
    });

    const body = (await get(me.token)).body;

    expect(sessionEntry(body, s.id)).toBeUndefined();
    expect(body.threads).toEqual([]);
  });

  it("omits a space session the caller can no longer read", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const other = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, { id: me.principalId }, "member");
    const s = await fixtures.session({ org, space, access: "space" });
    await fixtures.participant(s, { id: me.principalId });
    await seed.add(s.id, other.id);
    expect(sessionEntry((await get(me.token)).body, s.id)).toBeDefined();

    await prisma.spaceMember.delete({
      where: {
        spaceId_userId: { spaceId: space.id, userId: me.principalId },
      },
    });

    expect(sessionEntry((await get(me.token)).body, s.id)).toBeUndefined();
  });

  it("never shows another organization's sessions", async () => {
    const { me, other } = await setup();
    const foreign = await fixtures.session({ org: uuidv7() });
    await fixtures.participant(foreign, { id: me.principalId });
    await seed.add(foreign.id, other.id);

    expect(
      sessionEntry((await get(me.token)).body, foreign.id)
    ).toBeUndefined();
  });
});
