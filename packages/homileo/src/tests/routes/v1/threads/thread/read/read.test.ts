// @module-tag int
// @module-tag messages
// @module-tag events
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const put = (rootId: string, token: string, body: unknown) =>
  fetchJson("PUT", `${env.PUBLIC_URL}/v1/threads/${rootId}/read`, token, body);

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const author = await signIn(org);
  const reader = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: author.principalId });
  await fixtures.participant(session, { id: reader.principalId });
  const root = await sendMessage(session.id, author.token, { body: "root" });
  const rootId: string = root.body.message.id;
  const seqs: number[] = [];
  for (const b of ["a", "b", "c"]) {
    const r = await sendMessage(session.id, author.token, {
      body: b,
      threadRootId: rootId,
    });
    seqs.push(r.body.message.seq);
  }
  return { org, author, reader, session, rootId, seqs };
};

const events = (sessionId: string) =>
  prisma.event.findMany({
    where: { sessionId, type: "read.updated" },
    orderBy: { id: "asc" },
  });

describe("PUT /v1/threads/:rootId/read", () => {
  it("moves forward only, clamps to the newest reply, and records read.updated only when it moved", async () => {
    const { reader, session, rootId, seqs } = await room();

    expect((await put(rootId, reader.token, { seq: seqs[0] })).body).toEqual({
      lastReadSeq: seqs[0],
    });
    expect((await put(rootId, reader.token, { seq: 0 })).body).toEqual({
      lastReadSeq: seqs[0],
    });
    expect((await put(rootId, reader.token, { seq: seqs[0] })).body).toEqual({
      lastReadSeq: seqs[0],
    });
    expect((await put(rootId, reader.token, { seq: 9999 })).body).toEqual({
      lastReadSeq: seqs[2],
    });

    const recorded = (await events(session.id)).filter(
      (e) =>
        (e.payload as { principalId: string }).principalId ===
        reader.principalId
    );
    expect(recorded.map((e) => e.payload)).toEqual([
      {
        principalId: reader.principalId,
        sessionId: session.id,
        threadRootId: rootId,
        lastReadSeq: seqs[0],
      },
      {
        principalId: reader.principalId,
        sessionId: session.id,
        threadRootId: rootId,
        lastReadSeq: seqs[2],
      },
    ]);
    const row = await prisma.threadFollower.findUniqueOrThrow({
      where: {
        threadRootId_userId: {
          threadRootId: rootId,
          userId: reader.principalId,
        },
      },
    });
    expect(row.following).toBe(false);
  });

  it("clamps to the root's seq when the thread has no replies", async () => {
    const { reader, session, author } = await room();
    const lone = await sendMessage(session.id, author.token, { body: "lone" });

    const res = await put(lone.body.message.id, reader.token, { seq: 50 });

    expect(res.body).toEqual({ lastReadSeq: lone.body.message.seq });
  });

  it("answers 400 reply_to_reply for a reply, 404 to a non-reader, 400 to a bad body", async () => {
    const { org, reader, session, rootId, author } = await room();
    const reply = await sendMessage(session.id, author.token, {
      body: "r",
      threadRootId: rootId,
    });
    const stranger = await signIn(org);

    const refused = await put(reply.body.message.id, reader.token, { seq: 1 });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("reply_to_reply");
    expect((await put(rootId, stranger.token, { seq: 1 })).status).toBe(404);
    for (const body of [
      { seq: -1 },
      { seq: 1.5 },
      { seq: "1" },
      {},
      { seq: 1, x: 1 },
    ]) {
      expect((await put(rootId, reader.token, body)).status).toBe(400);
    }
    expect((await put("nope", reader.token, { seq: 1 })).status).toBe(400);
  });
});
