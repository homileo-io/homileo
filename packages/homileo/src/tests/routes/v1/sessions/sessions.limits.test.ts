// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../support/signedIn.js";
import { fetchJson, type JsonResponse } from "../../../support/http.js";
import { chatFixtures } from "../../../support/chatFixtures.js";
import { byId, walkPages } from "../../../support/pages.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/sessions`;
const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("GET /v1/sessions pagination", () => {
  it("pages through every session once, in order, across messaged and silent ones", async () => {
    const me = await signIn(org);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await fixtures.session({ org });
      await fixtures.participant(s, { id: me.principalId });
      ids.push(s.id);
    }
    // Two share a timestamp, so the id breaks the tie.
    const same = new Date(Date.now() - 5_000);
    await prisma.session.updateMany({
      where: { id: { in: [ids[0], ids[1]] } },
      data: { lastMessageAt: same },
    });
    await prisma.session.update({
      where: { id: ids[2] },
      data: { lastMessageAt: new Date() },
    });
    const all = await fetchJson("GET", `${URL}?limit=100`, me.token);
    const expected = all.body.data.map((s: { id: string }) => s.id);
    expect(expected).toHaveLength(7);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: JsonResponse = await fetchJson(
        "GET",
        `${URL}?limit=3${cursor ? `&cursor=${cursor}` : ""}`,
        me.token
      );
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((s: { id: string }) => s.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);

    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it.each([1, 2, 3, 4, 5])(
    "walks a space's sessions once, in order, across ties and from dated to undated, %i a page",
    async (limit) => {
      const me = await signIn(org);
      const space = await fixtures.space({ org, visibility: "public" });
      const at = (t: number) => new Date(Date.UTC(2026, 0, 1) + t * 1000);
      // [last_message_at, created_at]: ties in each key, and undated sessions sharing created_at.
      const shapes: [number | null, number][] = [
        [-1, -9],
        [-2, -8],
        [-2, -8],
        [-2, -7],
        [-3, -9],
        [null, -5],
        [null, -5],
        [null, -6],
      ];
      for (const [last, created] of shapes) {
        const s = await fixtures.session({ org, space, access: "space" });
        await prisma.session.update({
          where: { id: s.id },
          data: {
            lastMessageAt: last === null ? null : at(last),
            createdAt: at(created),
          },
        });
      }
      const rows = await prisma.session.findMany({
        where: { spaceId: space.id },
      });
      const time = (d: Date | null) => (d ? d.getTime() : -Infinity);
      const expected = rows
        .sort(
          (a, b) =>
            time(b.lastMessageAt) - time(a.lastMessageAt) ||
            b.createdAt.getTime() - a.createdAt.getTime() ||
            byId(b.id, a.id)
        )
        .map((s) => s.id);

      const { ids, pages } = await walkPages(
        me.token,
        (cursor) =>
          `${URL}?spaceId=${space.id}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
        (s) => String(s.id)
      );

      expect(ids).toEqual(expected);
      expect(pages).toBe(Math.ceil(expected.length / limit));
    }
  );

  it("returns nextCursor null when the page is the last", async () => {
    const me = await signIn(uuidv7());

    const res = await fetchJson("GET", `${URL}?limit=1`, me.token);

    expect(res.body).toEqual({ data: [], nextCursor: null });
  });

  it.each([
    ["not base64url", "!!!"],
    ["the wrong arity", Buffer.from('["a"]').toString("base64url")],
    [
      "a bad timestamp",
      Buffer.from(JSON.stringify(["x", "y", uuidv7()])).toString("base64url"),
    ],
    [
      "a bad id",
      Buffer.from(
        JSON.stringify(["", new Date().toISOString(), "nope"])
      ).toString("base64url"),
    ],
  ])("answers 400 to a cursor that is %s", async (_name, cursor) => {
    const me = await signIn(uuidv7());

    const res = await fetchJson("GET", `${URL}?cursor=${cursor}`, me.token);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it.each([["0"], ["101"], ["abc"]])(
    "answers 400 to limit=%s",
    async (limit) => {
      const me = await signIn(uuidv7());

      const res = await fetchJson("GET", `${URL}?limit=${limit}`, me.token);

      expect(res.status).toBe(400);
    }
  );
});
