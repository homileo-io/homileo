// @module-tag int
// @module-tag spaces
// @module-tag race
import { spaceApiFixtures } from "../../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../support/v1App.js";
import { fetchJson } from "../../../../../support/http.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

describe("POST /v1/spaces/:spaceId/join races", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("answers 200 with the same member to two simultaneous joins of an open space, and records one event", async () => {
    const org = api.organization();
    const space = await fixtures.space({
      org,
      joinPolicy: "open",
      visibility: "public",
    });
    const joiner = await api.actor(org);

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetchJson("POST", `${url}/v1/spaces/${space.id}/join`, joiner.token)
      )
    );

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body.member).toEqual(results[1].body.member);
    const events = await prisma.event.findMany({
      where: { organizationId: org, type: "space.member_added" },
    });
    expect(events).toHaveLength(1);
  });
});
