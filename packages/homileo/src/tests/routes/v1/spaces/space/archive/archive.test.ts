// @module-tag int
// @module-tag spaces
// @module-tag events
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { EVENT_TYPES } from "@homileo-io/sdk";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const archive = (token: string, id: string) =>
  fetchJson("POST", `${url}/v1/spaces/${id}/archive`, token);

describe("POST /v1/spaces/:spaceId/archive", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("refuses a moderator and a member, and archives for the owner", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const owner = await api.actor(org);
    const moderator = await api.actor(org);
    const member = await api.actor(org);
    await fixtures.member(space, owner.principal, "owner");
    await fixtures.member(space, moderator.principal, "moderator");
    await fixtures.member(space, member.principal, "member");

    expect((await archive(moderator.token, space.id)).status).toBe(403);
    expect((await archive(member.token, space.id)).status).toBe(403);
    const res = await archive(owner.token, space.id);

    expect(res.status).toBe(200);
    expect(res.body.space.id).toBe(space.id);
    expect(res.body.space.archivedAt).not.toBeNull();
  });

  it("lets an admin archive a space they are not in, and hides it from other organizations", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const admin = await api.actor(org, ["homileo.chat.admin"]);
    const foreign = await api.actor(api.organization(), ["homileo.chat.admin"]);
    const stranger = await api.actor(org);

    expect((await archive(foreign.token, space.id)).status).toBe(404);
    expect((await archive(stranger.token, space.id)).status).toBe(404);
    expect((await archive(admin.token, space.id)).status).toBe(200);
  });

  it("returns 409 already_archived the second time", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, owner.principal, "owner");
    await archive(owner.token, space.id);

    const res = await archive(owner.token, space.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_archived");
  });

  it("leaves the space's sessions unarchived", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, owner.principal, "owner");
    const session = await fixtures.session({ space });

    await archive(owner.token, space.id);

    expect(
      (await prisma.session.findUniqueOrThrow({ where: { id: session.id } }))
        .archivedAt
    ).toBeNull();
  });

  it("records space.archived, a webhook and an audit UPDATE, once", async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const space = await fixtures.space({ org });
    await fixtures.member(space, owner.principal, "owner");

    const res = await archive(owner.token, space.id);
    await archive(owner.token, space.id);

    const events = await prisma.event.findMany({
      where: { organizationId: org },
    });
    expect(events.map((e) => e.type)).toEqual(["space.archived"]);
    expect(
      EVENT_TYPES["space.archived"].payload.safeParse(events[0].payload).success
    ).toBe(true);
    expect(events[0].payload).toEqual({ space: res.body.space });
    const rows = await prisma.$queryRaw<
      Array<{ destination: string; payload: Record<string, unknown> }>
    >`SELECT destination, payload FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${org} ORDER BY destination`;
    expect(rows.map((r) => r.destination)).toEqual(["audit", "webhook"]);
    expect(rows[0].payload).toMatchObject({
      action: "UPDATE",
      entityType: "space",
      entityId: space.id,
    });
    expect(rows[1].payload.eventType).toBe("homileo.space.archived");
  });
});
