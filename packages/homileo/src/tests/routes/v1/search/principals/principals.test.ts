// @module-tag int
// @module-tag search
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchFixtures } from "../../../../support/searchApi.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { signIn } from "../../../../support/signedIn.js";

const s = searchFixtures();

beforeAll(s.start);
afterAll(s.cleanup);

const named = async (id: string, displayName: string) => {
  await prisma.principal.update({ where: { id }, data: { displayName } });
  return id;
};

/** A public session in an organization of its own, with no signed-in participant. */
const quietRoom = async () => {
  const org = s.organization();
  const space = await s.fixtures.space({ org, visibility: "public" });
  const session = await s.fixtures.session({ space, access: "space" });
  return { org, space, session };
};

const setup = async () => {
  const room = await quietRoom();
  const caller = await signIn(room.org, ["homileo.spaces.read"]);
  const join = async (displayName: string, o: { left?: boolean } = {}) => {
    const who = await s.fixtures.principal();
    await named(who.id, displayName);
    await s.fixtures.participant(room.session, who, "member", o);
    return who.id;
  };
  const names = async (q: string, params: Record<string, string> = {}) => {
    const res = await s.searchPrincipals(caller.token, { q, ...params });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as Array<{ displayName: string }>).map(
      (p) => p.displayName
    );
  };
  return { room, caller, join, names };
};

describe("GET /v1/search/principals", () => {
  it("finds a participant, including one who has left", async () => {
    const t = await setup();
    await t.join("Ada Lovelace");
    await t.join("Ada Gone", { left: true });

    expect((await t.names("ada")).sort()).toEqual(["Ada Gone", "Ada Lovelace"]);
  });

  it("returns principals as the principal view, bots included", async () => {
    const t = await setup();
    const bot = await s.fixtures.principal({ isBot: true });
    await named(bot.id, "Adabot");
    await s.fixtures.participant(t.room.session, bot);

    const res = await s.searchPrincipals(t.caller.token, { q: "adabot" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          id: bot.id,
          kind: "user",
          tereoUserId: bot.tereoUserId,
          isBot: true,
          displayName: "Adabot",
          avatarUrl: null,
        },
      ],
    });
  });

  it("does not return a principal who only takes part in a session the caller cannot read", async () => {
    const t = await setup();
    await t.join("Ada Lovelace");
    const hidden = await s.fixtures.space({
      org: t.room.org,
      visibility: "members",
    });
    const hiddenSession = await s.fixtures.session({
      space: hidden,
      access: "members",
    });
    const byron = await s.fixtures.principal();
    await named(byron.id, "Ada Byron");
    await s.fixtures.participant(hiddenSession, byron);

    expect(await t.names("ada")).toEqual(["Ada Lovelace"]);
  });

  it("does not return a principal from another organization", async () => {
    const t = await setup();
    await t.join("Ada Lovelace");
    const other = await quietRoom();
    const elsewhere = await s.fixtures.principal();
    await named(elsewhere.id, "Ada Elsewhere");
    await s.fixtures.participant(other.session, elsewhere);

    expect(await t.names("ada")).toEqual(["Ada Lovelace"]);
  });

  it("ranks a name starting with the query first", async () => {
    const t = await setup();
    await t.join("Canada Dry");
    await t.join("Ada");

    expect(await t.names("ada")).toEqual(["Ada", "Canada Dry"]);
  });

  it("matches % and _ literally", async () => {
    const t = await setup();
    await t.join("a_b");
    await t.join("axb");
    await t.join("100% Pure");

    expect(await t.names("a_b")).toEqual(["a_b"]);
    expect(await t.names("%")).toEqual(["100% Pure"]);
  });

  it("matches a backslash literally", async () => {
    const t = await setup();
    await t.join("a\\b");
    await t.join("axb");

    expect(await t.names("a\\b")).toEqual(["a\\b"]);
  });

  it("limits to 10 by default and to 20 at most", async () => {
    const t = await setup();
    for (let i = 0; i < 22; i++)
      await t.join(`Zed ${String(i).padStart(2, "0")}`);

    expect(await t.names("zed")).toHaveLength(10);
    expect(await t.names("zed", { limit: "20" })).toHaveLength(20);
    expect(await t.names("zed", { limit: "3" })).toHaveLength(3);
    const res = await s.searchPrincipals(t.caller.token, {
      q: "zed",
      limit: "21",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty or too long q", async () => {
    const t = await setup();

    for (const q of ["", "   ", "x".repeat(201)]) {
      const res = await s.searchPrincipals(t.caller.token, { q });
      expect(res.status).toBe(400);
    }
  });
});
