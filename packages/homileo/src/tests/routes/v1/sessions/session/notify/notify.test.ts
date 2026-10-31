// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();
const url = (id: string) => `${env.PUBLIC_URL}/v1/sessions/${id}/notify`;

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("PUT /v1/sessions/:sessionId/notify", () => {
  it("sets the level, returns the participant and records no event", async () => {
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId });

    const res = await fetchJson("PUT", url(s.id), me.token, {
      notify: "mentions",
    });

    expect(res.status).toBe(200);
    expect(res.body.participant).toMatchObject({
      principalId: me.principalId,
      notify: "mentions",
    });
    expect(await prisma.event.count({ where: { sessionId: s.id } })).toBe(0);
  });

  it("answers 400 to an unknown level, 403 not_a_participant to a reader, 404 to a stranger", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const reader = await signIn(org);
    const foreign = await signIn(uuidv7());

    expect(
      (await fetchJson("PUT", url(s.id), reader.token, { notify: "loud" }))
        .status
    ).toBe(400);
    const refused = await fetchJson("PUT", url(s.id), reader.token, {
      notify: "all",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_a_participant");
    expect(
      (await fetchJson("PUT", url(s.id), foreign.token, { notify: "all" }))
        .status
    ).toBe(404);
  });
});
