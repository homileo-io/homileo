// @module-tag int
// @module-tag spaces
// @module-tag events
import { spaceApiFixtures } from "../../../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../../support/v1App.js";
import { fetchJson } from "../../../../../../support/http.js";
import { v7 as uuidv7 } from "uuid";
import pg from "pg";

const SESSIONS = 3_000;
// Every third session is `access: members`, so removal revokes it.
const isMembersOnly = (i: number) => i % 3 === 0;

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

describe("DELETE /v1/spaces/:spaceId/members/:principalId at scale", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it(`removes a member from ${SESSIONS} sessions and records every event in id order`, async () => {
    const org = api.organization();
    const owner = await api.actor(org);
    const space = await fixtures.space({
      org,
      createdBy: owner.principal,
      visibility: "public",
    });
    await fixtures.member(space, owner.principal, "owner");
    const target = await fixtures.principal();
    await fixtures.member(space, target);

    const sessionIds = Array.from({ length: SESSIONS }, () => uuidv7());
    await prisma.session.createMany({
      data: sessionIds.map((id, i) => ({
        id,
        organizationId: org,
        spaceId: space.id,
        type: "group" as const,
        access: isMembersOnly(i) ? ("members" as const) : ("space" as const),
        createdBy: owner.principal.id,
      })),
    });
    await prisma.sessionParticipant.createMany({
      data: sessionIds.map((sessionId) => ({ sessionId, userId: target.id })),
    });

    // The app runs in this process, so this counts the removal's statements.
    const statements = vi.spyOn(pg.Client.prototype, "query");
    const started = Date.now();
    const res = await fetchJson(
      "DELETE",
      `${url}/v1/spaces/${space.id}/members/${target.id}`,
      owner.token
    );
    const elapsed = Date.now() - started;
    const count = statements.mock.calls.length;
    statements.mockRestore();

    expect(res.status).toBe(204);
    // A fixed number, however many sessions: one or more per session would be thousands.
    expect(count).toBeLessThan(50);
    expect(elapsed).toBeLessThan(8_000);
    expect(
      await prisma.sessionParticipant.count({
        where: { userId: target.id, leftAt: null },
      })
    ).toBe(0);

    const events = await prisma.event.findMany({
      where: { organizationId: org },
      orderBy: { id: "asc" },
    });
    const ofType = (type: string) => events.filter((e) => e.type === type);
    const membersOnly = sessionIds.filter((_, i) => isMembersOnly(i)).sort();
    expect(events[0].type).toBe("space.member_removed");
    expect(
      ofType("session.participant_removed").map((e) => e.sessionId)
    ).toEqual([...sessionIds].sort());
    expect(ofType("session.access_revoked").map((e) => e.sessionId)).toEqual(
      membersOnly
    );
    expect(events.at(-1)!.type).toBe("session.access_revoked");

    const webhooks = await prisma.$queryRaw<
      Array<{ event_type: string; event_id: string }>
    >`
      SELECT payload->>'eventType' AS event_type,
             payload->'data'->>'eventId' AS event_id
      FROM "core"."core_outbox"
      WHERE destination = 'webhook' AND payload->>'organizationId' = ${org}
      ORDER BY id`;
    const removed = ofType("session.participant_removed");
    expect(webhooks).toHaveLength(1 + SESSIONS);
    expect(webhooks.map((w) => w.event_id)).toEqual(
      [events[0], ...removed].map((e) => String(e.id))
    );
    const privateIds = new Set(membersOnly);
    expect(webhooks.slice(1).map((w) => w.event_type)).toEqual(
      removed.map((e) =>
        privateIds.has(e.sessionId!)
          ? "homileo.private_session.participant_removed"
          : "homileo.session.participant_removed"
      )
    );
  }, 60_000);
});
