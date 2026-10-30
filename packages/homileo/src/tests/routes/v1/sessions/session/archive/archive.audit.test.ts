// @module-tag int
// @module-tag sessions
// @module-tag events
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("POST /v1/sessions/:sessionId/archive events", () => {
  it("records session.archived and an UPDATE audit entry, and nothing for a repeat", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "owner");
    const url = `${env.PUBLIC_URL}/v1/sessions/${s.id}/archive`;

    const first = await fetchJson("POST", url, me.token);
    await fetchJson("POST", url, me.token);

    const events = await prisma.event.findMany({ where: { sessionId: s.id } });
    expect(events.map((e) => e.type)).toEqual(["session.archived"]);
    expect(events[0].payload).toEqual({ session: first.body.session });
    const audit = await prisma.$queryRaw<Array<{ payload: object }>>`
      SELECT payload FROM "core"."core_outbox"
      WHERE destination = 'audit' AND payload->>'entityId' = ${s.id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      action: "UPDATE",
      entityType: "session",
      userId: me.tereoUserId,
    });
  });
});
