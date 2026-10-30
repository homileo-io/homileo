// @module-tag int
// @module-tag spaces
// @module-tag race
import { spaceApiFixtures } from "../../../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../../support/v1App.js";
import { fetchJson } from "../../../../../../support/http.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

describe("concurrent member changes", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("lets exactly one of two owners demote the other, leaving one owner", async () => {
    const org = api.organization();
    const a = await api.actor(org);
    const b = await api.actor(org);
    const space = await fixtures.space({ org, createdBy: a.principal });
    await fixtures.member(space, a.principal, "owner");
    await fixtures.member(space, b.principal, "owner");
    const demote = (by: typeof a, who: typeof a) =>
      fetchJson(
        "PUT",
        `${url}/v1/spaces/${space.id}/members/${who.principal.id}`,
        by.token,
        { role: "member" }
      );

    const results = await Promise.all([demote(a, b), demote(b, a)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, role: "owner" },
      })
    ).toBe(1);
  });

  it("lets exactly one of two owners leave", async () => {
    const org = api.organization();
    const a = await api.actor(org);
    const b = await api.actor(org);
    const space = await fixtures.space({ org, createdBy: a.principal });
    await fixtures.member(space, a.principal, "owner");
    await fixtures.member(space, b.principal, "owner");
    const leave = (who: typeof a) =>
      fetchJson(
        "DELETE",
        `${url}/v1/spaces/${space.id}/members/${who.principal.id}`,
        who.token
      );

    const results = await Promise.all([leave(a), leave(b)]);

    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, role: "owner" },
      })
    ).toBe(1);
  });
});
