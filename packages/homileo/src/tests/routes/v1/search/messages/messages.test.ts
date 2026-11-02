// @module-tag int
// @module-tag search
import { deleteMessage, editMessage } from "../../../../support/messageApi.js";
import { hitIds, searchFixtures } from "../../../../support/searchApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionKind } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { signIn } from "../../../../support/signedIn.js";

const s = searchFixtures();

beforeAll(s.start);
afterAll(s.cleanup);

/** The ids found for `q` (and any filters) by the room's sender. */
const found = async (
  token: string,
  q: string,
  params: Record<string, string> = {}
) => {
  const res = await s.search(token, { q, ...params });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return hitIds(res.body);
};

describe("GET /v1/search/messages", () => {
  it("finds a message by a stemmed word", async () => {
    const r = await s.room();
    const id = await r.send("the screws are missing");

    expect(await found(r.sender.token, "screw")).toEqual([id]);
  });

  it("matches a phrase in order only", async () => {
    const r = await s.room();
    const id = await r.send("two missing screws found");
    await r.send("screws are not missing");

    expect(await found(r.sender.token, '"missing screws"')).toEqual([id]);
  });

  it("drops messages with an excluded word", async () => {
    const r = await s.room();
    const id = await r.send("refund please");
    await r.send("refund the shipping");

    expect(await found(r.sender.token, "refund -shipping")).toEqual([id]);
  });

  it("finds a partial identifier", async () => {
    const r = await s.room();
    const id = await r.send("order ORD-1234 is late");

    expect(await found(r.sender.token, "1234")).toEqual([id]);
  });

  it("finds a misspelt word", async () => {
    const r = await s.room();
    const id = await r.send("broken controller");

    expect(await found(r.sender.token, "controler")).toEqual([id]);
  });

  it("finds a message by its attachment's file name", async () => {
    const r = await s.room();
    const id = await s.insert(r.session, r.sender.principalId, null);
    await s.attach(id, "invoice-77.pdf");

    const res = await s.search(r.sender.token, { q: "invoice" });
    expect(hitIds(res.body)).toEqual([id]);
    expect(res.body.data[0].snippet).toEqual({ text: "", highlights: [] });
  });

  it("matches the current text of an edited message only", async () => {
    const r = await s.room();
    const id = await r.send("old words");
    const edited = await editMessage(
      id,
      r.sender.token,
      { body: "new words" },
      s.url()
    );
    expect(edited.status).toBe(200);

    expect(await found(r.sender.token, "old")).toEqual([]);
    expect(await found(r.sender.token, "new")).toEqual([id]);
  });

  it("never returns a deleted message, even by its attachment", async () => {
    const r = await s.room();
    const id = await r.send("doomed invoice text");
    await s.attach(id, "invoice-12.pdf");
    expect((await deleteMessage(id, r.sender.token, s.url())).status).toBe(200);

    expect(await found(r.sender.token, "doomed")).toEqual([]);
    expect(await found(r.sender.token, "invoice")).toEqual([]);
  });

  it("answers a hit with the message, its session and a snippet", async () => {
    const r = await s.room();
    const id = await r.send("the screws are missing");

    const res = await s.search(r.sender.token, { q: "screw" });
    const [hit] = res.body.data;
    expect(hit.message).toMatchObject({ id, body: "the screws are missing" });
    expect(hit.session).toMatchObject({
      id: r.session.id,
      spaceId: r.space.id,
    });
    expect(hit.snippet.text).toContain("screws");
    expect(hit.snippet.highlights).toHaveLength(1);
    const [[start, end]] = hit.snippet.highlights;
    expect(hit.snippet.text.slice(start, end)).toBe("screws");
    expect(res.body.nextCursor).toBeNull();
  });

  it("answers 400 invalid_request for a query that fails the schema", async () => {
    const r = await s.room();
    const res = await s.search(r.sender.token, { q: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
  });

  it("answers 400 for the metadata key __proto__ instead of dropping the filter", async () => {
    const r = await s.room();
    const res = await s.search(r.sender.token, {
      q: "screws",
      "metadata[__proto__]": "x",
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_request" });
  });

  it.each(["the", "-"])(
    "answers no results for %j, whose tsquery is empty",
    async (q) => {
      const r = await s.room();
      await r.send("screws missing");

      const res = await s.search(r.sender.token, { q });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    }
  );
});

describe("GET /v1/search/messages ranking", () => {
  it("puts the newer of two equally matching messages first", async () => {
    const r = await s.room();
    const older = await r.send("same gadget words");
    const newer = await r.send("same gadget words");

    expect(await found(r.sender.token, "gadget")).toEqual([newer, older]);
  });

  it("puts a message naming the term three times above one naming it once", async () => {
    const r = await s.room();
    const thrice = await r.send("screw, another screw, and a third screw");
    const once = await r.send("one screw here");

    expect(await found(r.sender.token, "screw")).toEqual([thrice, once]);
  });

  it("puts an older file named exactly the term above a newer fuzzy body match", async () => {
    const r = await s.room();
    const byFile = await s.insert(r.session, r.sender.principalId, null);
    await s.attach(byFile, "quotation.pdf");
    const fuzzy = await r.send("a quotaton was sent");

    expect(await found(r.sender.token, "quotation")).toEqual([byFile, fuzzy]);
  });
});

describe("GET /v1/search/messages filters", () => {
  it("narrows by sessionId, spaceId, kind and senderId", async () => {
    const kind = await provisionKind({
      defaults: { visibility: "public", join: "open", posting: "members" },
    });
    const a = await s.room();
    const b = await s.room({ space: a.space });
    const c = await s.room({ org: a.org, kind });
    const other = await signIn(a.org);
    await s.fixtures.participant(a.session, { id: other.principalId });
    const inA = await a.send("widget alpha");
    const byOther = await s.sendTo(a.session, other.token, "widget other");
    const inB = await b.send("widget beta");
    const inC = await c.send("widget gamma");
    const t = a.sender.token;

    expect(await found(t, "widget")).toEqual([inC, inB, byOther, inA]);
    expect(await found(t, "widget", { sessionId: a.session.id })).toEqual([
      byOther,
      inA,
    ]);
    expect(await found(t, "widget", { spaceId: a.space.id })).toEqual([
      inB,
      byOther,
      inA,
    ]);
    expect(await found(t, "widget", { kind })).toEqual([inC]);
    expect(await found(t, "widget", { senderId: other.principalId })).toEqual([
      byOther,
    ]);
  });

  it("narrows by from (inclusive) and to (exclusive) on createdAt", async () => {
    const r = await s.room();
    const days = ["2026-01-01", "2026-01-02", "2026-01-03"];
    const ids: string[] = [];
    for (const day of days) {
      const id = await r.send(`dated widget ${day}`);
      await prisma.message.update({
        where: { id },
        data: { createdAt: new Date(`${day}T00:00:00.000Z`) },
      });
      ids.push(id);
    }
    const t = r.sender.token;

    expect(
      await found(t, "widget", { from: "2026-01-02T00:00:00.000Z" })
    ).toEqual([ids[2], ids[1]]);
    expect(
      await found(t, "widget", { to: "2026-01-03T00:00:00.000Z" })
    ).toEqual([ids[1], ids[0]]);
  });

  it("narrows by hasAttachment", async () => {
    const r = await s.room();
    const plain = await r.send("widget plain");
    const withFile = await r.send("widget filed");
    await s.attach(withFile, "drawing.png");
    const t = r.sender.token;

    expect(await found(t, "widget", { hasAttachment: "true" })).toEqual([
      withFile,
    ]);
    expect(await found(t, "widget", { hasAttachment: "false" })).toEqual([
      plain,
    ]);
  });

  it("narrows by inThread", async () => {
    const r = await s.room();
    const root = await r.send("widget root");
    const reply = await r.send("widget reply", { threadRootId: root });
    const t = r.sender.token;

    expect(await found(t, "widget", { inThread: "true" })).toEqual([reply]);
    expect(await found(t, "widget", { inThread: "false" })).toEqual([root]);
  });

  it("narrows by a metadata value on the session", async () => {
    const a = await s.room({ sessionMetadata: { orderNumber: "ORD-1234" } });
    const b = await s.room({ space: a.space });
    const inA = await a.send("widget tagged");
    await b.send("widget untagged");

    expect(
      await found(a.sender.token, "widget", {
        "metadata[orderNumber]": "ORD-1234",
      })
    ).toEqual([inA]);
  });

  it("narrows by a metadata value on the session's space", async () => {
    const a = await s.room({ spaceMetadata: { orderNumber: "ORD-1234" } });
    const b = await s.room({ org: a.org });
    const inA = await a.send("widget tagged");
    await b.send("widget untagged");

    expect(
      await found(a.sender.token, "widget", {
        "metadata[orderNumber]": "ORD-1234",
      })
    ).toEqual([inA]);
  });

  it("matches a metadata number or boolean by its spelling", async () => {
    const a = await s.room({
      sessionMetadata: { orderNumber: 1234, urgent: true },
    });
    const inA = await a.send("widget typed");
    const t = a.sender.token;

    expect(
      await found(t, "widget", { "metadata[orderNumber]": "1234" })
    ).toEqual([inA]);
    expect(await found(t, "widget", { "metadata[urgent]": "true" })).toEqual([
      inA,
    ]);
    expect(await found(t, "widget", { "metadata[urgent]": "false" })).toEqual(
      []
    );
  });
});

describe("GET /v1/search/messages paging", () => {
  it("pages 25 matches by 10, and leaves out messages sent after page 1", async () => {
    const r = await s.room();
    const sent: string[] = [];
    for (let i = 0; i < 25; i++) sent.push(await r.send(`paged sprocket ${i}`));
    const t = r.sender.token;

    const sizes: number[] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const params: Record<string, string> = { q: "sprocket", limit: "10" };
      if (cursor) params.cursor = cursor;
      const res = await s.search(t, params);
      expect(res.status).toBe(200);
      sizes.push(res.body.data.length);
      seen.push(...hitIds(res.body));
      cursor = res.body.nextCursor;
      if (sizes.length === 1) await r.send("late sprocket");
    } while (cursor);

    expect(sizes).toEqual([10, 10, 5]);
    expect(seen).toEqual([...sent].reverse());
  });
});
