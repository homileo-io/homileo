// @module-tag int
// @module-tag sessions
// @module-tag race
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/sessions/direct`;
const org = uuidv7();

afterAll(() => purgeOrganizations([org]));

describe("POST /v1/sessions/direct races", () => {
  it("creates one session when five creates of the same pair run at once", async () => {
    const a = await signIn(org);
    const b = await signIn(org);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetchJson("POST", URL, i % 2 ? a.token : b.token, {
          principalId: i % 2 ? b.principalId : a.principalId,
        })
      )
    );

    expect(results.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);
    expect(new Set(results.map((r) => r.body.session.id)).size).toBe(1);
    const id = results[0].body.session.id;
    expect(
      await prisma.session.count({
        where: { organizationId: org, type: "direct" },
      })
    ).toBe(1);
    expect(
      await prisma.sessionParticipant.count({ where: { sessionId: id } })
    ).toBe(2);
    const events = await prisma.event.findMany({
      where: { organizationId: org, sessionId: id },
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      "session.created",
      "session.participant_added",
      "session.participant_added",
    ]);
  });
});
