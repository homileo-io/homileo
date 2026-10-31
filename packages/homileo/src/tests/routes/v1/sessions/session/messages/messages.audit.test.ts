// @module-tag int
// @module-tag sessions
// @module-tag messages
// @module-tag events
import { purgeOrganizations, signIn } from "../../../../../support/signedIn.js";
import { chatFixtures } from "../../../../../support/chatFixtures.js";
import { sendMessage } from "../../../../../support/messageApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@homileo-io/sdk";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const org = uuidv7();

afterAll(async () => {
  await fixtures.cleanup();
  await purgeOrganizations([org]);
});

const outbox = (sessionId: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${org}
      AND payload->'data'->'message'->>'sessionId' = ${sessionId}
    ORDER BY id`;

const room = async () => {
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId }, "owner");
  return { me, session };
};

describe("POST /v1/sessions/:sessionId/messages events", () => {
  it("records message.created, a homileo.message.created webhook and no audit entry", async () => {
    const { me, session } = await room();

    const sent = await sendMessage(session.id, me.token, { body: "hi" });

    expect(sent.status).toBe(201);
    const events = await prisma.event.findMany({
      where: { sessionId: session.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message.created",
      organizationId: org,
      spaceId: null,
      actorId: me.principalId,
    });
    expect(
      EVENT_TYPES["message.created"].payload.parse(events[0].payload)
    ).toEqual({ message: sent.body.message });
    const rows = await outbox(session.id);
    expect(rows.map((r) => r.destination)).toEqual(["webhook"]);
    expect(rows[0].payload).toMatchObject({
      eventType: "homileo.message.created",
      organizationId: org,
      entityId: sent.body.message.id,
    });
  });

  it("records message.created, then thread.updated, for a reply", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });

    const reply = await sendMessage(session.id, me.token, {
      body: "reply",
      threadRootId: root.body.message.id,
    });

    const events = await prisma.event.findMany({
      where: { sessionId: session.id },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "message.created",
      "message.created",
      "thread.updated",
    ]);
    expect(
      EVENT_TYPES["thread.updated"].payload.parse(events[2].payload)
    ).toEqual({
      sessionId: session.id,
      rootId: root.body.message.id,
      replyCount: 1,
      lastReplyAt: reply.body.message.createdAt,
    });
    const webhooks = await prisma.$queryRaw<Array<{ eventType: string }>>`
      SELECT payload->>'eventType' AS "eventType" FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${org}
        AND payload->>'entityId' = ${root.body.message.id}
        AND destination = 'webhook'
      ORDER BY id`;
    expect(webhooks.map((w) => w.eventType)).toEqual([
      "homileo.message.created",
      "homileo.thread.updated",
    ]);
  });

  it("records nothing for a duplicate clientMessageId", async () => {
    const { me, session } = await room();
    const clientMessageId = uuidv7();
    await sendMessage(session.id, me.token, { clientMessageId, body: "a" });

    const again = await sendMessage(session.id, me.token, {
      clientMessageId,
      body: "a",
    });

    expect(again.status).toBe(409);
    expect(await prisma.event.count({ where: { sessionId: session.id } })).toBe(
      1
    );
    expect(await outbox(session.id)).toHaveLength(1);
  });
});
