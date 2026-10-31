// @module-tag int
// @module-tag messages
// @module-tag events
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@homileo-io/sdk";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  editMessage,
  sendMessage,
} from "../../../../support/messageApi.js";

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
  return { org, me, session };
};

const eventsOf = (sessionId: string) =>
  prisma.event.findMany({ where: { sessionId }, orderBy: { id: "asc" } });

const outbox = (org: string, entityId: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`
    SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${org} AND payload->>'entityId' = ${entityId}
    ORDER BY id`;

describe("PATCH /v1/messages/:messageId events", () => {
  it("records message.edited and a homileo.message.edited webhook, with no audit entry", async () => {
    const { org, me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "a" });
    const id = sent.body.message.id;

    const res = await editMessage(id, me.token, { body: "b" });

    const events = (await eventsOf(session.id)).filter(
      (e) => e.type === "message.edited"
    );
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(me.principalId);
    expect(
      EVENT_TYPES["message.edited"].payload.parse(events[0].payload)
    ).toEqual({ message: res.body.message });
    const rows = await outbox(org, id);
    expect(rows.map((r) => r.payload.eventType)).toEqual([
      "homileo.message.created",
      "homileo.message.edited",
    ]);
    expect(rows.every((r) => r.destination === "webhook")).toBe(true);
  });

  it("records message.edited for a metadata-only change and nothing for a no-op", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "a" });
    const id = sent.body.message.id;

    await editMessage(id, me.token, { metadata: { k: "v" } });
    await editMessage(id, me.token, { metadata: { k: "v" } });
    await editMessage(id, me.token, { body: "a" });

    const types = (await eventsOf(session.id)).map((e) => e.type);
    expect(types).toEqual(["message.created", "message.edited"]);
  });

  it("records nothing for a refused edit", async () => {
    const { org, me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "a" });
    const other = await signIn(org);

    await editMessage(sent.body.message.id, other.token, { body: "b" });
    await editMessage(sent.body.message.id, me.token, { payload: {} });

    expect(await eventsOf(session.id)).toHaveLength(1);
  });
});

describe("DELETE /v1/messages/:messageId events", () => {
  it("records message.deleted with no audit entry when the sender deletes", async () => {
    const { org, me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "a" });
    const id = sent.body.message.id;

    const res = await deleteMessage(id, me.token);

    const events = await eventsOf(session.id);
    expect(events.map((e) => e.type)).toEqual([
      "message.created",
      "message.deleted",
    ]);
    expect(
      EVENT_TYPES["message.deleted"].payload.parse(events[1].payload)
    ).toEqual({ message: res.body.message });
    const rows = await outbox(org, id);
    expect(rows.map((r) => r.destination)).toEqual(["webhook", "webhook"]);
    expect(rows[1].payload.eventType).toBe("homileo.message.deleted");
  });

  it("records an audit DELETE when a moderator deletes someone else's message", async () => {
    const org = uuidv7();
    orgs.push(org);
    const space = await fixtures.space({ org });
    const session = await fixtures.session({ org, space, access: "space" });
    const sender = await signIn(org);
    const moderator = await signIn(org);
    await fixtures.member(space, { id: sender.principalId });
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.participant(session, { id: sender.principalId });
    await fixtures.participant(session, { id: moderator.principalId });
    const sent = await sendMessage(session.id, sender.token, { body: "a" });
    const id = sent.body.message.id;

    await deleteMessage(id, moderator.token);

    const audits = (await outbox(org, id)).filter(
      (r) => r.destination === "audit"
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      action: "DELETE",
      userId: moderator.tereoUserId,
      entityType: "message",
      entityId: id,
    });
  });

  it("records message.deleted, then thread.updated, for a reply", async () => {
    const { me, session } = await room();
    const root = await sendMessage(session.id, me.token, { body: "root" });
    const reply = await sendMessage(session.id, me.token, {
      body: "reply",
      threadRootId: root.body.message.id,
    });

    await deleteMessage(reply.body.message.id, me.token);

    const events = (await eventsOf(session.id)).slice(3);
    expect(events.map((e) => e.type)).toEqual([
      "message.deleted",
      "thread.updated",
    ]);
    expect(
      EVENT_TYPES["thread.updated"].payload.parse(events[1].payload)
    ).toMatchObject({
      sessionId: session.id,
      rootId: root.body.message.id,
      replyCount: 0,
    });
  });

  it("records nothing for a refused or repeated delete", async () => {
    const { me, session } = await room();
    const sent = await sendMessage(session.id, me.token, { body: "a" });
    await deleteMessage(sent.body.message.id, me.token);

    await deleteMessage(sent.body.message.id, me.token);

    expect(await eventsOf(session.id)).toHaveLength(2);
  });
});
