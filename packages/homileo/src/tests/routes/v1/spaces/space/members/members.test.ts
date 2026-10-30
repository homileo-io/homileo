// @module-tag int
// @module-tag spaces
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "../../../../../../utils/cursor.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const list = (token: string, spaceId: string, query = "") =>
  fetchJson("GET", `${url}/v1/spaces/${spaceId}/members${query}`, token);

const setup = async () => {
  const org = api.organization();
  const owner = await api.actor(org);
  const space = await fixtures.space({ org, createdBy: owner.principal });
  await fixtures.member(space, owner.principal, "owner");
  return { org, owner, space };
};

describe("GET /v1/spaces/:spaceId/members", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("lists the members with their principals, oldest first", async () => {
    const { org, owner, space } = await setup();
    const a = await api.actor(org);
    const b = await api.actor(org);
    await prisma.spaceMember.create({
      data: {
        spaceId: space.id,
        userId: a.principal.id,
        role: "member",
        joinedAt: new Date(Date.now() + 1000),
      },
    });
    await prisma.spaceMember.create({
      data: {
        spaceId: space.id,
        userId: b.principal.id,
        role: "moderator",
        joinedAt: new Date(Date.now() + 2000),
      },
    });

    const res = await list(owner.token, space.id);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(
      res.body.data.map((m: { principalId: string }) => m.principalId)
    ).toEqual([owner.principal.id, a.principal.id, b.principal.id]);
    expect(res.body.data[2]).toMatchObject({
      spaceId: space.id,
      role: "moderator",
      principal: {
        id: b.principal.id,
        tereoUserId: b.principal.tereoUserId,
        isBot: false,
      },
    });
  });

  it("filters by role", async () => {
    const { org, owner, space } = await setup();
    const m = await api.actor(org);
    await fixtures.member(space, m.principal, "member");

    const res = await list(owner.token, space.id, "?role=member");

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].principalId).toBe(m.principal.id);
  });

  it("pages with a cursor", async () => {
    const { org, owner, space } = await setup();
    for (let i = 0; i < 3; i++) {
      const m = await api.actor(org);
      await fixtures.member(space, m.principal);
    }

    const first = await list(owner.token, space.id, "?limit=2");
    const second = await list(
      owner.token,
      space.id,
      `?limit=2&cursor=${first.body.nextCursor}`
    );

    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    expect(second.body.data).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.data, ...second.body.data].map(
      (m: { principalId: string }) => m.principalId
    );
    expect(new Set(ids).size).toBe(4);
  });

  it("lets a reader of a public space list its members", async () => {
    const { org, space } = await setup();
    await prisma.space.update({
      where: { id: space.id },
      data: { visibility: "public" },
    });
    const reader = await api.actor(org);

    expect((await list(reader.token, space.id)).status).toBe(200);
  });

  it("answers 404 to a caller who cannot read the space", async () => {
    const { org, space } = await setup();
    const outsider = await api.actor(org);
    const foreign = await api.actor(api.organization());

    expect((await list(outsider.token, space.id)).status).toBe(404);
    expect((await list(foreign.token, space.id)).status).toBe(404);
  });

  it("answers 400 to a malformed id, role, limit or cursor", async () => {
    const { owner, space } = await setup();

    expect((await list(owner.token, "nope")).status).toBe(400);
    expect((await list(owner.token, space.id, "?role=boss")).status).toBe(400);
    expect((await list(owner.token, space.id, "?limit=0")).status).toBe(400);
    expect((await list(owner.token, space.id, "?cursor=!!")).status).toBe(400);
    const wrongKind = encodeCursor([1, 2]);
    expect(
      (await list(owner.token, space.id, `?cursor=${wrongKind}`)).status
    ).toBe(400);
  });
});
