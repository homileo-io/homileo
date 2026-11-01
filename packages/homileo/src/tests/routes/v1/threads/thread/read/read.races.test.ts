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

describe("PUT /v1/threads/:rootId/read races", () => {
  it("leaves the higher seq when two reads land at once", async () => {
    const author = await signIn(org);
    const reader = await signIn(org);
    const session = await fixtures.session({ org });
    await fixtures.participant(session, { id: author.principalId });
    await fixtures.participant(session, { id: reader.principalId });
    const root = await sendMessage(session.id, author.token, { body: "root" });
    const rootId: string = root.body.message.id;
    const seqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await sendMessage(session.id, author.token, {
        body: `r${i}`,
        threadRootId: rootId,
      });
      seqs.push(r.body.message.seq);
    }
    const put = (seq: number) =>
      fetchJson(
        "PUT",
        `${env.PUBLIC_URL}/v1/threads/${rootId}/read`,
        reader.token,
        { seq }
      );

    const results = await Promise.all([put(seqs[4]), put(seqs[8])]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const row = await prisma.threadFollower.findUniqueOrThrow({
      where: {
        threadRootId_userId: {
          threadRootId: rootId,
          userId: reader.principalId,
        },
      },
    });
    expect(Number(row.lastReadSeq)).toBe(seqs[8]);
  });
});
