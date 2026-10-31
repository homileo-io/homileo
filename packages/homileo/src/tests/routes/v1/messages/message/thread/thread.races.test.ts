// @module-tag int
// @module-tag messages
// @module-tag race
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { messageUrl, sendMessage } from "../../../../../support/messageApi.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations([org]);
});

describe("GET /v1/messages/:messageId/thread races", () => {
  it("keeps root.replyCount equal to the replies listed while replies are posted", async () => {
    const me = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: me.principalId });
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const rootId: string = root.body.message.id;

    const posting = Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        sendMessage(session.id, me.token, {
          body: `r${i}`,
          threadRootId: rootId,
        })
      )
    );
    const reads: Array<{
      root: { replyCount: number };
      data: unknown[];
      hasAfter: boolean;
    }> = [];
    let done = false;
    void posting.then(() => (done = true));
    while (!done) {
      const res = await fetchJson(
        "GET",
        `${messageUrl(rootId)}/thread?limit=100`,
        me.token
      );
      expect(res.status).toBe(200);
      reads.push(res.body);
    }
    await posting;

    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const read of reads) {
      expect(read.hasAfter).toBe(false);
      expect(read.root.replyCount).toBe(read.data.length);
    }
  });
});
