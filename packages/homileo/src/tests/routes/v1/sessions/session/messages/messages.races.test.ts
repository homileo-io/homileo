// @module-tag int
// @module-tag sessions
// @module-tag messages
// @module-tag race
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const room = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId }, "owner");
  return { me, session };
};

describe("concurrent sends", () => {
  it("gives 20 parallel sends the seqs 1 to 20, each once", async () => {
    const { me, session } = await room();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sendMessage(session.id, me.token, { body: `m${i}` })
      )
    );

    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const seqs = results
      .map((r) => r.body.message.seq as number)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.lastSeq).toBe(20n);
  });

  it("answers 5 parallel sends of one clientMessageId with one 201 and four 409s carrying it", async () => {
    const { me, session } = await room();
    const clientMessageId = uuidv7();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        sendMessage(session.id, me.token, { clientMessageId, body: "once" })
      )
    );

    const created = results.filter((r) => r.status === 201);
    const duplicates = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(duplicates).toHaveLength(4);
    const id = created[0].body.message.id;
    for (const d of duplicates) {
      expect(d.body).toMatchObject({
        error: "duplicate_client_message",
        message: { id, seq: 1, clientMessageId },
      });
    }
    expect(
      await prisma.message.count({ where: { sessionId: session.id } })
    ).toBe(1);
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.lastSeq).toBe(1n);
    expect(
      await prisma.event.count({
        where: { sessionId: session.id, type: "message.created" },
      })
    ).toBe(1);
  });
});
