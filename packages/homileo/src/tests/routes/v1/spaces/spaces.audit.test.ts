// @module-tag int
// @module-tag spaces
// @module-tag events
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../support/spaceApi.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { startV1App } from "../../../support/v1App.js";
import { fetchJson } from "../../../support/http.js";
import { EVENT_TYPES } from "@homileo-io/sdk";
import { v7 as uuidv7 } from "uuid";

const api = spaceApiFixtures();
let url: string;
let close: () => Promise<unknown>;

describe("POST /v1/spaces events", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("records space.created, then space.member_added per member, creator first", async () => {
    const org = api.organization();
    const botUser = uuidv7();
    const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
      bots: [botUser],
    });
    const { principal, token } = await api.actor(org, ["homileo.spaces.write"]);

    const res = await fetchJson("POST", `${url}/v1/spaces`, token, {
      kind,
      name: "Audited",
    });

    expect(res.status).toBe(201);
    const events = await prisma.event.findMany({
      where: { organizationId: org },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "space.created",
      "space.member_added",
      "space.member_added",
    ]);
    for (const e of events) {
      const type = e.type as keyof typeof EVENT_TYPES;
      expect(EVENT_TYPES[type].payload.safeParse(e.payload).success).toBe(true);
      expect(e).toMatchObject({
        spaceId: res.body.space.id,
        sessionId: null,
        actorId: principal.id,
      });
    }
    expect(events[0].payload).toEqual({ space: res.body.space });
    expect(events[1].payload).toMatchObject({
      member: { principalId: principal.id, role: "owner" },
    });
    expect(events[2].payload).toMatchObject({ member: { role: "member" } });
  });

  it("queues the space.created webhook and an audit CREATE entry", async () => {
    const org = api.organization();
    const { principal, token } = await api.actor(org, ["homileo.spaces.write"]);

    const res = await fetchJson("POST", `${url}/v1/spaces`, token, {
      name: "Hooked",
    });

    const rows = await prisma.$queryRaw<
      Array<{ destination: string; payload: Record<string, unknown> }>
    >`SELECT destination, payload FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${org} ORDER BY destination`;
    const audit = rows.find((r) => r.destination === "audit");
    const hooks = rows.filter((r) => r.destination === "webhook");
    expect(audit?.payload).toMatchObject({
      action: "CREATE",
      entityType: "space",
      entityId: res.body.space.id,
      userId: principal.tereoUserId,
    });
    expect(hooks.map((h) => h.payload.eventType)).toEqual([
      "homileo.space.created",
      "homileo.space.member_added",
    ]);
    expect(hooks[0].payload).toMatchObject({
      entityType: "space",
      entityId: res.body.space.id,
    });
  });

  it("records nothing when the create fails", async () => {
    const org = api.organization();
    const { token } = await api.actor(org, ["homileo.spaces.write"]);
    await fetchJson("POST", `${url}/v1/spaces`, token, {
      name: "a",
      externalRef: "r",
    });
    const before = await prisma.event.count({ where: { organizationId: org } });

    const dup = await fetchJson("POST", `${url}/v1/spaces`, token, {
      name: "b",
      externalRef: "r",
    });

    expect(dup.status).toBe(409);
    expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
      before
    );
  });
});
