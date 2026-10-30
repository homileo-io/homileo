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
const url = (id: string) => `${env.PUBLIC_URL}/v1/sessions/${id}/read`;
const events = (sessionId: string) =>
  prisma.event.findMany({
    where: { sessionId, type: "read.updated" },
    orderBy: { id: "asc" },
  });

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

const setup = async () => {
  const me = await signIn(org);
  const s = await fixtures.session({ org });
  await prisma.session.update({ where: { id: s.id }, data: { lastSeq: 10n } });
  await fixtures.participant(s, { id: me.principalId });
  return { me, s };
};

describe("PUT /v1/sessions/:sessionId/read", () => {
  it("moves forward only, is clamped to last_seq, and records read.updated only when it moved", async () => {
    const { me, s } = await setup();
    const put = (seq: number) => fetchJson("PUT", url(s.id), me.token, { seq });

    expect((await put(4)).body).toEqual({ lastReadSeq: 4 });
    expect((await put(2)).body).toEqual({ lastReadSeq: 4 });
    expect((await put(4)).body).toEqual({ lastReadSeq: 4 });
    expect((await put(99)).body).toEqual({ lastReadSeq: 10 });
    expect((await put(10)).body).toEqual({ lastReadSeq: 10 });

    const recorded = await events(s.id);
    expect(recorded.map((e) => e.payload)).toEqual([
      {
        principalId: me.principalId,
        sessionId: s.id,
        threadRootId: null,
        lastReadSeq: 4,
      },
      {
        principalId: me.principalId,
        sessionId: s.id,
        threadRootId: null,
        lastReadSeq: 10,
      },
    ]);
    expect(recorded[0].actorId).toBe(me.principalId);
  });

  it("answers 403 not_a_participant to a reader who is not a participant, and 404 to a stranger", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const reader = await signIn(org);
    const foreign = await signIn(uuidv7());

    const refused = await fetchJson("PUT", url(s.id), reader.token, { seq: 1 });

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_a_participant");
    expect(
      (await fetchJson("PUT", url(s.id), foreign.token, { seq: 1 })).status
    ).toBe(404);
  });

  it.each([
    ["a negative seq", { seq: -1 }],
    ["a fractional seq", { seq: 1.5 }],
    ["a string seq", { seq: "1" }],
    ["no seq", {}],
    ["an extra key", { seq: 1, extra: 1 }],
  ])("answers 400 to %s", async (_n, body) => {
    const { me, s } = await setup();

    expect((await fetchJson("PUT", url(s.id), me.token, body)).status).toBe(
      400
    );
  });
});
