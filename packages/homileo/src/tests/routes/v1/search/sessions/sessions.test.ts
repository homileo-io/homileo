// @module-tag int
// @module-tag search
import { removeKinds, provisionKind } from "../../../../support/v1App.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchFixtures } from "../../../../support/searchApi.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { signIn } from "../../../../support/signedIn.js";
import { fetchJson } from "../../../../support/http.js";

const s = searchFixtures();

beforeAll(s.start);
afterAll(async () => {
  await s.cleanup();
  await removeKinds();
});

const setup = async () => {
  const org = s.organization();
  const kind = await provisionKind({
    search: { metadata: ["customerName", "orderNumber"] },
    defaults: { visibility: "public", join: "open", posting: "members" },
  });
  const user = await signIn(org, ["homileo.spaces.write"]);
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetchJson(
      "POST",
      `${s.url()}/v1${path}`,
      user.token,
      body
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const space = async (
    name: string,
    metadata: Record<string, unknown> = {},
    k = kind
  ): Promise<string> =>
    (await post("/spaces", { kind: k, name, metadata })).space.id;
  const session = async (
    name: string,
    metadata: Record<string, unknown> = {},
    spaceId?: string
  ): Promise<string> =>
    (await post("/sessions", { spaceId, name, metadata })).session.id;
  /** The `type:id` of each hit, in order. */
  const found = async (q: string, params: Record<string, string> = {}) => {
    const res = await s.searchSessions(user.token, { q, ...params });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body.data as Array<Record<string, { id: string }>>).map(
      (h) => `${h.type}:${(h.space ?? h.session).id}`
    );
  };
  return { org, kind, user, post, space, session, found };
};

describe("GET /v1/search/sessions", () => {
  it("finds spaces and sessions in one list, each tagged with its type", async () => {
    const t = await setup();
    const space = await t.space("Lovelace account");
    const session = await t.session(
      "Ticket",
      { customerName: "Ada Lovelace" },
      space
    );

    const res = await s.searchSessions(t.user.token, { q: "lovelace" });

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data).toHaveLength(2);
    const byType = Object.fromEntries(
      res.body.data.map((h: { type: string }) => [h.type, h])
    );
    expect(byType.space.space.id).toBe(space);
    expect(byType.session.session.id).toBe(session);
  });

  it("does not match the value of an undeclared metadata key", async () => {
    const t = await setup();
    await t.space("Plain", { internal: "lovelace" });
    await t.session("Plain", { internal: "lovelace" });

    expect(await t.found("lovelace")).toEqual([]);
  });

  it("finds a partial identifier through the trigram arm", async () => {
    const t = await setup();
    const space = await t.space("Orders");
    const id = await t.session("Order", { orderNumber: "ORD-1234" }, space);

    expect(await t.found("ORD-12")).toEqual([`session:${id}`]);
  });

  it("filters on exact metadata, a number by its spelling", async () => {
    const t = await setup();
    const text = await t.session("Widget order", { orderNumber: "ORD-1234" });
    const num = await t.session("Widget order", { orderNumber: 1234 });
    await t.session("Widget order", { orderNumber: "ORD-9999" });

    expect(
      await t.found("widget", { "metadata[orderNumber]": "ORD-1234" })
    ).toEqual([`session:${text}`]);
    expect(
      await t.found("widget", { "metadata[orderNumber]": "1234" })
    ).toEqual([`session:${num}`]);
    expect(
      await t.found("widget", { "metadata[orderNumber]": "01234" })
    ).toEqual([]);
  });

  it("applies a metadata filter to a space's own metadata", async () => {
    const t = await setup();
    const hit = await t.space("Widget", { orderNumber: "A-1" });
    await t.space("Widget", { orderNumber: "A-2" });

    expect(await t.found("widget", { "metadata[orderNumber]": "A-1" })).toEqual(
      [`space:${hit}`]
    );
  });

  it("filters by kind: that kind's spaces and the sessions in them", async () => {
    const t = await setup();
    const other = await provisionKind({
      search: { metadata: [] },
      defaults: { visibility: "public", join: "open", posting: "members" },
    });
    const a = await t.space("Gadget one");
    const b = await t.space("Gadget two", {}, other);
    const inA = await t.session("Gadget a", {}, a);
    await t.session("Gadget b", {}, b);
    await t.session("Gadget loose");

    expect((await t.found("gadget", { kind: t.kind })).sort()).toEqual(
      [`space:${a}`, `session:${inA}`].sort()
    );
  });

  it("filters by spaceId: only that space's sessions, no spaces", async () => {
    const t = await setup();
    const a = await t.space("Gizmo one");
    const b = await t.space("Gizmo two");
    const inA = await t.session("Gizmo a", {}, a);
    await t.session("Gizmo b", {}, b);

    expect(await t.found("gizmo", { spaceId: a })).toEqual([`session:${inA}`]);
  });

  it("returns an archived session with archivedAt set", async () => {
    const t = await setup();
    const id = await t.session("Old thing");
    await prisma.session.update({
      where: { id },
      data: { archivedAt: new Date() },
    });

    const res = await s.searchSessions(t.user.token, { q: "thing" });

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].session.archivedAt).not.toBeNull();
  });

  it("ranks a session by its last message before an older one", async () => {
    const t = await setup();
    const older = await t.session("Sprocket");
    const newer = await t.session("Sprocket");
    await prisma.session.update({
      where: { id: older },
      data: { lastMessageAt: new Date(Date.now() - 60_000) },
    });
    await prisma.session.update({
      where: { id: newer },
      data: { lastMessageAt: new Date() },
    });

    expect(await t.found("sprocket")).toEqual([
      `session:${newer}`,
      `session:${older}`,
    ]);
  });
});

describe("GET /v1/search/sessions paging", () => {
  it("pages 25 matches by 10, leaving out ones created after page 1", async () => {
    const t = await setup();
    const made: string[] = [];
    for (let i = 0; i < 25; i++)
      made.push(`session:${await t.session(`Paged cog ${i}`)}`);

    const sizes: number[] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, string> = { q: "cog", limit: "10" };
      if (cursor) params.cursor = cursor;
      const res = await s.searchSessions(t.user.token, params);
      expect(res.status).toBe(200);
      sizes.push(res.body.data.length);
      seen.push(
        ...res.body.data.map(
          (h: { session: { id: string } }) => `session:${h.session.id}`
        )
      );
      cursor = res.body.nextCursor;
      if (sizes.length === 1) await t.session("Late cog");
    } while (cursor);

    expect(sizes).toEqual([10, 10, 5]);
    expect(new Set(seen)).toEqual(new Set(made));
  });

  it("answers 400 Invalid cursor for a cursor past the depth", async () => {
    const t = await setup();
    const { encodeSearchCursor } =
      await import("../../../../../utils/search.js");

    const res = await s.searchSessions(t.user.token, {
      q: "cog",
      cursor: encodeSearchCursor(new Date(), 100),
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error_description: "Invalid cursor" });
  });

  it("answers 400 for the metadata key __proto__", async () => {
    const t = await setup();

    const res = await s.searchSessions(t.user.token, {
      q: "cog",
      "metadata[__proto__]": "x",
    });

    expect(res.status).toBe(400);
  });
});
