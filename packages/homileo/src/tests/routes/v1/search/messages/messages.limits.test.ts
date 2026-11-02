// @module-tag int
// @module-tag search
import { hitIds, searchFixtures } from "../../../../support/searchApi.js";
import { encodeSearchCursor } from "../../../../../utils/search.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import env from "../../../../../env.js";

const s = searchFixtures();

beforeAll(s.start);
afterAll(s.cleanup);

describe("GET /v1/search/messages limits", () => {
  it("runs the test server at the lowest depth", () => {
    expect(env.SEARCH_MAX_DEPTH).toBe(100);
  });

  it("stops at SEARCH_MAX_DEPTH results with nextCursor null", async () => {
    const r = await s.room();
    for (let i = 0; i < env.SEARCH_MAX_DEPTH + 5; i++) {
      await s.insert(r.session, r.sender.principalId, `deep needle ${i}`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: Record<string, string> = { q: "needle", limit: "30" };
      if (cursor) params.cursor = cursor;
      const res = await s.search(r.sender.token, params);
      expect(res.status).toBe(200);
      seen.push(...hitIds(res.body));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toHaveLength(env.SEARCH_MAX_DEPTH);
    expect(new Set(seen).size).toBe(env.SEARCH_MAX_DEPTH);
    expect(cursor).toBeNull();
  });

  it.each([
    ["past the depth", () => encodeSearchCursor(new Date(), 100)],
    ["with a negative offset", () => encodeSearchCursor(new Date(), -10)],
    [
      "with a non-date asOf",
      () => Buffer.from(JSON.stringify(["soon", 20])).toString("base64url"),
    ],
    ["that is not a cursor", () => "not-a-cursor"],
  ])("answers 400 invalid_request for a cursor %s", async (_name, cursor) => {
    const r = await s.room();
    const res = await s.search(r.sender.token, {
      q: "needle",
      cursor: cursor(),
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "invalid_request",
      error_description: "Invalid cursor",
    });
  });
});
