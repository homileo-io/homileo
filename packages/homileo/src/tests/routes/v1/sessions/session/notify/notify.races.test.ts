// @module-tag int
// @module-tag sessions
// @module-tag race
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
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

describe("PUT /v1/sessions/:sessionId/notify races", () => {
  it("answers 200 or 403 not_a_participant, never 500, when the caller leaves at the same time", async () => {
    for (let round = 0; round < 5; round++) {
      const me = await signIn(org);
      const s = await fixtures.session({ org });
      await fixtures.participant(
        s,
        { id: (await fixtures.principal()).id },
        "owner"
      );
      await fixtures.participant(s, { id: me.principalId });
      const base = `${env.PUBLIC_URL}/v1/sessions/${s.id}`;

      const [notify, leave] = await Promise.all([
        fetchJson("PUT", `${base}/notify`, me.token, { notify: "none" }),
        fetchJson("DELETE", `${base}/participants/${me.principalId}`, me.token),
      ]);

      expect(leave.status).toBe(204);
      expect([200, 403, 404]).toContain(notify.status);
      if (notify.status === 403) {
        expect(notify.body.error).toBe("not_a_participant");
      }
    }
  });
});
