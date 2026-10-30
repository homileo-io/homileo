// @module-tag int
// @module-tag sessions
// @module-tag events
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../support/http.js";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/sessions`;
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

describe("PATCH /v1/sessions/:sessionId events", () => {
  it("records session.updated with the new session and an UPDATE audit entry", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      name: "Audited",
    });

    expect(res.status).toBe(200);
    const events = await prisma.event.findMany({
      where: { sessionId: s.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.updated",
      actorId: me.principalId,
      organizationId: org,
    });
    expect(events[0].payload).toEqual({ session: res.body.session });
    const audit = (await outbox(s.id)).filter((r) => r.destination === "audit");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      action: "UPDATE",
      entityType: "session",
      entityId: s.id,
      userId: me.tereoUserId,
      organizationId: org,
    });
  });

  it("records nothing when the patch changes nothing", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    await prisma.session.update({
      where: { id: s.id },
      data: { name: "Same", metadata: { a: 1 } },
    });

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      name: "Same",
      metadata: { a: 1 },
    });

    expect(res.status).toBe(200);
    expect(await prisma.event.count({ where: { sessionId: s.id } })).toBe(0);
    expect(await outbox(s.id)).toEqual([]);
  });

  it("records no event for a refused patch", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "member");

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      name: "Nope",
    });

    expect(res.status).toBe(403);
    expect(await prisma.event.count({ where: { sessionId: s.id } })).toBe(0);
  });
});
