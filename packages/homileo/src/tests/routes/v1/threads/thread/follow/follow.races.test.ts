// @module-tag int
// @module-tag messages
// @module-tag race
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations([org]);
});

describe("PUT /v1/threads/:rootId/follow races", () => {
  it("creates one follower row when follows and thread reads of a new thread run at once", async () => {
    const author = await signIn(org);
    const reader = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: author.principalId });
    await fixtures.participant(session, { id: reader.principalId });
    const root = await sendMessage(session.id, author.token, { body: "root" });
    const rootId: string = root.body.message.id;
    const thread = `${env.PUBLIC_URL}/v1/threads/${rootId}`;

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2
          ? fetchJson("PUT", `${thread}/follow`, reader.token, {
              following: true,
            })
          : fetchJson("PUT", `${thread}/read`, reader.token, { seq: 1 })
      )
    );

    expect(results.map((r) => r.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    const rows = await prisma.threadFollower.findMany({
      where: { threadRootId: rootId, userId: reader.principalId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].following).toBe(true);
  });
});
