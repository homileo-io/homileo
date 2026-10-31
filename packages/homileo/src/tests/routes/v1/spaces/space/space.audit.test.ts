// @module-tag int
// @module-tag spaces
// @module-tag events
import { spaceApiFixtures } from "../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../support/v1App.js";
import { fetchJson } from "../../../../support/http.js";
import { EVENT_TYPES } from "@homileo-io/sdk";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const outbox = (org: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${org} ORDER BY destination`;

const ownedSpace = async () => {
  const org = api.organization();
  const owner = await api.actor(org);
  const space = await fixtures.space({ org, createdBy: owner.principal });
  await fixtures.member(space, owner.principal, "owner");
  return { org, owner, space };
};

describe("PATCH /v1/spaces/:spaceId events", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("records space.updated with the new space, a webhook and an audit UPDATE", async () => {
    const { org, owner, space } = await ownedSpace();

    const res = await fetchJson(
      "PATCH",
      `${url}/v1/spaces/${space.id}`,
      owner.token,
      { name: "Audited", description: "d" }
    );

    expect(res.status).toBe(200);
    const events = await prisma.event.findMany({
      where: { organizationId: org },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "space.updated",
      spaceId: space.id,
      actorId: owner.principal.id,
    });
    expect(
      EVENT_TYPES["space.updated"].payload.safeParse(events[0].payload).success
    ).toBe(true);
    expect(events[0].payload).toEqual({ space: res.body.space });
    const rows = await outbox(org);
    expect(rows.find((r) => r.destination === "audit")?.payload).toMatchObject({
      action: "UPDATE",
      entityType: "space",
      entityId: space.id,
      userId: owner.principal.tereoUserId,
    });
    expect(
      rows
        .filter((r) => r.destination === "webhook")
        .map((r) => r.payload.eventType)
    ).toEqual(["homileo.space.updated"]);
  });

  it("records nothing for a repeat that changes nothing, or a refused change", async () => {
    const { org, owner, space } = await ownedSpace();
    const patch = (token: string, body: object) =>
      fetchJson("PATCH", `${url}/v1/spaces/${space.id}`, token, body);
    await patch(owner.token, { name: "Once" });
    const before = await prisma.event.count({ where: { organizationId: org } });
    const rowsBefore = (await outbox(org)).length;
    const stranger = await api.actor(org);

    await patch(owner.token, { name: "Once" });
    await patch(stranger.token, { name: "Hacked" });
    await patch(owner.token, { externalRef: "r", state: "nope" });

    expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
      before
    );
    expect((await outbox(org)).length).toBe(rowsBefore);
  });
});
