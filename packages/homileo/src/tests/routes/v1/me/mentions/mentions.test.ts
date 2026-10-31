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
const MENTIONS = `${env.PUBLIC_URL}/v1/me/mentions`;

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

interface Item {
  message: { id: string };
  session: { id: string };
}

const get = (token: string, query = "") =>
  fetchJson("GET", `${MENTIONS}${query}`, token);

describe("GET /v1/me/mentions", () => {
  it("answers 401 without a token", async () => {
    expect((await fetchJson("GET", MENTIONS, null)).status).toBe(401);
  });

  it("lists user, here and session mentions newest first, with their session", async () => {
    const { me, other, s } = await setup();
    const a = await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });
    const b = await seed.add(s.id, other.id, { mentions: [{ kind: "here" }] });
    const c = await seed.add(s.id, other.id, {
      mentions: [{ kind: "session" }],
    });
    await seed.add(s.id, other.id);

    const res = await get(me.token);

    expect(res.status).toBe(200);
    expect(res.body.data.map((i: Item) => i.message.id)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);
    expect(res.body.data[0].session.id).toBe(s.id);
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns a message mentioned by user and by here once", async () => {
    const { me, other, s } = await setup();
    const m = await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }, { kind: "here" }],
    });

    const res = await get(me.token);

    expect(res.body.data.map((i: Item) => i.message.id)).toEqual([m.id]);
  });

  it("excludes deleted messages, the caller's own, and mentions of others", async () => {
    const { me, other, s } = await setup();
    await seed.add(s.id, other.id, {
      deleted: true,
      mentions: [{ kind: "here" }],
    });
    await seed.add(s.id, me.principalId, { mentions: [{ kind: "here" }] });
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: other.id }],
    });

    expect((await get(me.token)).body.data).toEqual([]);
  });

  it("includes mentions in replies", async () => {
    const { me, other, s } = await setup();
    const root = await seed.add(s.id, me.principalId);
    const reply = await seed.add(s.id, other.id, {
      threadRootId: root.id,
      mentions: [{ kind: "user", userId: me.principalId }],
    });

    const res = await get(me.token);

    expect(res.body.data.map((i: Item) => i.message.id)).toEqual([reply.id]);
  });

  it("pages with a cursor, advancing past every row exactly once", async () => {
    const { me, other, s } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift(
        (
          await seed.add(s.id, other.id, {
            mentions: [{ kind: "user", userId: me.principalId }],
          })
        ).id
      );
    }

    const first = await get(me.token, "?limit=2");
    const second = await get(
      me.token,
      `?limit=2&cursor=${first.body.nextCursor}`
    );
    const third = await get(
      me.token,
      `?limit=2&cursor=${second.body.nextCursor}`
    );

    const seen = [first, second, third].flatMap((r) =>
      r.body.data.map((i: Item) => i.message.id)
    );
    expect(seen).toEqual(ids);
    expect(first.body.nextCursor).not.toBeNull();
    expect(third.body.nextCursor).toBeNull();
  });

  it("drops mentions in a session the caller was removed from, and here mentions after leaving", async () => {
    const { me, other, s } = await setup();
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });
    await seed.add(s.id, other.id, { mentions: [{ kind: "here" }] });
    await prisma.sessionParticipant.update({
      where: {
        sessionId_userId: { sessionId: s.id, userId: me.principalId },
      },
      data: { leftAt: new Date() },
    });

    expect((await get(me.token)).body.data).toEqual([]);
  });

  it("drops a user mention in a space session once the caller loses access", async () => {
    const org = uuidv7();
    orgs.push(org);
    const me = await signIn(org);
    const other = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    await fixtures.member(space, { id: me.principalId }, "member");
    const s = await fixtures.session({ org, space, access: "space" });
    await seed.add(s.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });
    expect((await get(me.token)).body.data).toHaveLength(1);

    await prisma.spaceMember.delete({
      where: {
        spaceId_userId: { spaceId: space.id, userId: me.principalId },
      },
    });

    expect((await get(me.token)).body.data).toEqual([]);
  });

  it("never returns another organization's mentions", async () => {
    const { me, other } = await setup();
    const foreign = await fixtures.session({ org: uuidv7() });
    await fixtures.participant(foreign, { id: me.principalId });
    await seed.add(foreign.id, other.id, {
      mentions: [{ kind: "user", userId: me.principalId }],
    });

    expect((await get(me.token)).body.data).toEqual([]);
  });

  it.each([
    ["a malformed cursor", "?cursor=!!"],
    ["limit 0", "?limit=0"],
    ["limit 101", "?limit=101"],
  ])("answers 400 to %s", async (_n, query) => {
    const { me } = await setup();

    expect((await get(me.token, query)).status).toBe(400);
  });
});
