// @module-tag int
// @module-tag sessions
// @module-tag events
import { purgeOrganizations, signIn } from "../../../support/signedIn.js";
import { chatFixtures } from "../../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

const outbox = (sessionId: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'entityId' = ${sessionId} ORDER BY id`;

describe("POST /v1/sessions events", () => {
  it("records session.created then one participant_added each, with a CREATE audit entry", async () => {
    const me = await signIn(org);
    const other = await signIn(org);

    const res = await fetchJson(
      "POST",
      `${env.PUBLIC_URL}/v1/sessions`,
      me.token,
      {
        participantIds: [other.principalId],
      }
    );

    const id = res.body.session.id;
    const events = await prisma.event.findMany({
      where: { sessionId: id },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "session.created",
      "session.participant_added",
      "session.participant_added",
    ]);
    expect(events[0].payload).toEqual({ session: res.body.session });
    expect(events[0].actorId).toBe(me.principalId);
    expect(events[1].payload).toMatchObject({
      sessionId: id,
      participant: { principalId: me.principalId, role: "owner" },
    });
    const audit = (await outbox(id)).filter((r) => r.destination === "audit");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      action: "CREATE",
      entityType: "session",
      userId: me.tereoUserId,
    });
  });

  it("records nothing for a refused create", async () => {
    const me = await signIn(org);
    const space = await fixtures.space({ org });

    const res = await fetchJson(
      "POST",
      `${env.PUBLIC_URL}/v1/sessions`,
      me.token,
      {
        spaceId: space.id,
      }
    );

    expect(res.status).toBe(404);
    expect(await prisma.event.count({ where: { spaceId: space.id } })).toBe(0);
  });

  it("records the DM's creation once, and nothing for a repeat", async () => {
    const a = await signIn(org);
    const b = await signIn(org);
    const url = `${env.PUBLIC_URL}/v1/sessions/direct`;

    const first = await fetchJson("POST", url, a.token, {
      principalId: b.principalId,
    });
    await fetchJson("POST", url, b.token, { principalId: a.principalId });

    const events = await prisma.event.findMany({
      where: { sessionId: first.body.session.id },
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      "session.created",
      "session.participant_added",
      "session.participant_added",
    ]);
    const audit = (await outbox(first.body.session.id)).filter(
      (r) => r.destination === "audit"
    );
    expect(audit).toHaveLength(1);
  });
});
