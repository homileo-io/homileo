// @module-tag int
// @module-tag spaces
// @module-tag events
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { EVENT_TYPES } from "@homileo-io/sdk";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const outbox = (org: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${org} ORDER BY id`;

const setup = async () => {
  const org = api.organization();
  const owner = await api.actor(org);
  const space = await fixtures.space({ org, createdBy: owner.principal });
  await fixtures.member(space, owner.principal, "owner");
  const target = await api.actor(org);
  return { org, owner, space, target };
};

const eventsOf = (org: string) =>
  prisma.event.findMany({
    where: { organizationId: org },
    orderBy: { id: "asc" },
  });

const expectAudit = async (
  org: string,
  spaceId: string,
  userId: string | null,
  action: string
) => {
  const audit = (await outbox(org)).filter((r) => r.destination === "audit");
  expect(audit).toHaveLength(1);
  expect(audit[0].payload).toMatchObject({
    action,
    entityType: "space",
    entityId: spaceId,
    userId,
  });
};

describe("member events", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("PUT of a new member records space.member_added with a webhook and an audit CREATE", async () => {
    const { org, owner, space, target } = await setup();

    const res = await fetchJson(
      "PUT",
      `${url}/v1/spaces/${space.id}/members/${target.principal.id}`,
      owner.token,
      { role: "member" }
    );

    const events = await eventsOf(org);
    expect(events.map((e) => e.type)).toEqual(["space.member_added"]);
    expect(events[0]).toMatchObject({
      spaceId: space.id,
      actorId: owner.principal.id,
    });
    expect(events[0].payload).toEqual({
      spaceId: space.id,
      member: res.body.member,
    });
    expect(
      EVENT_TYPES["space.member_added"].payload.safeParse(events[0].payload)
        .success
    ).toBe(true);
    expect((await outbox(org)).map((r) => r.destination)).toContain("webhook");
    await expectAudit(org, space.id, owner.principal.tereoUserId, "CREATE");
  });

  it("a role change records space.member_role_changed with the previous role and an audit UPDATE", async () => {
    const { org, owner, space, target } = await setup();
    await fixtures.member(space, target.principal, "member");

    const res = await fetchJson(
      "PUT",
      `${url}/v1/spaces/${space.id}/members/${target.principal.id}`,
      owner.token,
      { role: "moderator" }
    );

    const events = await eventsOf(org);
    expect(events.map((e) => e.type)).toEqual(["space.member_role_changed"]);
    expect(events[0].payload).toEqual({
      spaceId: space.id,
      member: res.body.member,
      previousRole: "member",
    });
    await expectAudit(org, space.id, owner.principal.tereoUserId, "UPDATE");
  });

  it("DELETE records space.member_removed and an audit DELETE", async () => {
    const { org, owner, space, target } = await setup();
    await fixtures.member(space, target.principal, "member");

    await fetchJson(
      "DELETE",
      `${url}/v1/spaces/${space.id}/members/${target.principal.id}`,
      owner.token
    );

    const events = (await eventsOf(org)).filter(
      (e) => e.type === "space.member_removed"
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      spaceId: space.id,
      principalId: target.principal.id,
    });
    await expectAudit(org, space.id, owner.principal.tereoUserId, "DELETE");
  });

  it("a refused change records nothing", async () => {
    const { org, owner, space } = await setup();

    const res = await fetchJson(
      "DELETE",
      `${url}/v1/spaces/${space.id}/members/${owner.principal.id}`,
      owner.token
    );

    expect(res.status).toBe(409);
    expect(await eventsOf(org)).toHaveLength(0);
    expect(await outbox(org)).toHaveLength(0);
  });
});
