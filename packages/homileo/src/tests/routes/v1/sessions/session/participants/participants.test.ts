// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();
const url = (id: string, query = "") =>
  `${env.PUBLIC_URL}/v1/sessions/${id}/participants${query}`;

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("GET /v1/sessions/:sessionId/participants", () => {
  it("lists current participants with their principal, oldest first, and skips those who left", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    const other = await fixtures.principal();
    const gone = await fixtures.principal();
    await fixtures.participant(s, other);
    await fixtures.participant(s, gone, "member", { left: true });

    const res = await fetchJson("GET", url(s.id), me.token);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(
      res.body.data.map((p: { principalId: string }) => p.principalId)
    ).toEqual([me.principalId, other.id]);
    expect(res.body.data[0]).toMatchObject({
      sessionId: s.id,
      role: "owner",
      principal: { id: me.principalId, tereoUserId: me.tereoUserId },
    });
  });

  it("pages with a cursor", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    for (let i = 0; i < 2; i++) {
      await fixtures.participant(s, await fixtures.principal());
    }

    const first = await fetchJson("GET", url(s.id, "?limit=2"), me.token);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await fetchJson(
      "GET",
      url(s.id, `?limit=2&cursor=${first.body.nextCursor}`),
      me.token
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.data, ...second.body.data].map(
      (p: { principalId: string }) => p.principalId
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("answers 400 to a malformed cursor and 404 to someone who cannot read the session", async () => {
    const me = await signIn(org);
    const outsider = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    const bad = Buffer.from(JSON.stringify([5, "x"])).toString("base64url");

    expect(
      (await fetchJson("GET", url(s.id, `?cursor=${bad}`), me.token)).status
    ).toBe(400);
    expect((await fetchJson("GET", url(s.id), outsider.token)).status).toBe(
      404
    );
    expect((await fetchJson("GET", url("nope"), me.token)).status).toBe(400);
  });
});
