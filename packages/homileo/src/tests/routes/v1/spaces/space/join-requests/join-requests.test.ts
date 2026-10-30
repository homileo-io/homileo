// @module-tag int
// @module-tag spaces
import { spaceApiFixtures } from "../../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../support/v1App.js";
import { fetchJson } from "../../../../../support/http.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const list = (token: string, spaceId: string, query = "") =>
  fetchJson("GET", `${url}/v1/spaces/${spaceId}/join-requests${query}`, token);

const setup = async () => {
  const org = api.organization();
  const moderator = await api.actor(org);
  const space = await fixtures.space({
    org,
    createdBy: moderator.principal,
    joinPolicy: "request",
    visibility: "public",
  });
  await fixtures.member(space, moderator.principal, "moderator");
  return { org, moderator, space };
};

const request = async (
  spaceId: string,
  userId: string,
  status: "pending" | "approved" | "denied" = "pending"
) => prisma.spaceJoinRequest.create({ data: { spaceId, userId, status } });

describe("GET /v1/spaces/:spaceId/join-requests", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("lists pending requests by default, oldest first", async () => {
    const { org, moderator, space } = await setup();
    const a = await api.actor(org);
    const b = await api.actor(org);
    const c = await api.actor(org);
    const first = await request(space.id, a.principal.id);
    const second = await request(space.id, b.principal.id);
    await request(space.id, c.principal.id, "denied");

    const res = await list(moderator.token, space.id);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(res.body.data[0]).toMatchObject({
      spaceId: space.id,
      principalId: a.principal.id,
      status: "pending",
      principal: { id: a.principal.id, isBot: false },
    });
  });

  it("filters by status", async () => {
    const { org, moderator, space } = await setup();
    const a = await api.actor(org);
    await request(space.id, a.principal.id, "denied");

    const res = await list(moderator.token, space.id, "?status=denied");

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("denied");
  });

  it("pages with a cursor", async () => {
    const { org, moderator, space } = await setup();
    for (let i = 0; i < 3; i++) {
      await request(space.id, (await api.actor(org)).principal.id);
    }

    const first = await list(moderator.token, space.id, "?limit=2");
    const second = await list(
      moderator.token,
      space.id,
      `?limit=2&cursor=${first.body.nextCursor}`
    );

    expect(first.body.data).toHaveLength(2);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it("walks every request one at a time with the cursor", async () => {
    const { org, moderator, space } = await setup();
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      made.push(
        (await request(space.id, (await api.actor(org)).principal.id)).id
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: {
        body: { data: Array<{ id: string }>; nextCursor: string | null };
      } = await list(
        moderator.token,
        space.id,
        `?limit=1${cursor ? `&cursor=${cursor}` : ""}`
      );
      expect(res.body.data).toHaveLength(1);
      seen.push(res.body.data[0].id);
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toEqual(made);
  });

  it("answers 403 to a reader who cannot moderate and 404 to one who cannot read", async () => {
    const { org, space } = await setup();
    const member = await api.actor(org);
    await fixtures.member(space, member.principal, "member");
    const hidden = await fixtures.space({ org });
    const outsider = await api.actor(org);

    expect((await list(member.token, space.id)).status).toBe(403);
    expect((await list(outsider.token, hidden.id)).status).toBe(404);
  });

  it("answers 400 to a bad status, limit, cursor or id", async () => {
    const { moderator, space } = await setup();

    expect((await list(moderator.token, space.id, "?status=old")).status).toBe(
      400
    );
    expect((await list(moderator.token, space.id, "?limit=101")).status).toBe(
      400
    );
    expect((await list(moderator.token, space.id, "?cursor=!!")).status).toBe(
      400
    );
    expect((await list(moderator.token, "nope")).status).toBe(400);
  });
});
