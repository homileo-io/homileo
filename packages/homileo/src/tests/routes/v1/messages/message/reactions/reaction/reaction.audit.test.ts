// @module-tag int
// @module-tag messages
// @module-tag events
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { afterAll, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@homileo-io/sdk";
import { v7 as uuidv7 } from "uuid";
import {
  addReaction,
  removeReaction,
  sendMessage,
} from "../../../../../../support/messageApi.js";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

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
  const sent = await sendMessage(session.id, me.token, { body: "a" });
  return { org, me, session, id: sent.body.message.id as string };
};

const eventsOf = (sessionId: string, prefix = "reaction.") =>
  prisma.event
    .findMany({ where: { sessionId }, orderBy: { id: "asc" } })
    .then((all) => all.filter((e) => e.type.startsWith(prefix)));

const outbox = (org: string, entityId: string) =>
  prisma.$queryRaw<
    Array<{ destination: string; payload: Record<string, unknown> }>
  >`
    SELECT destination, payload FROM "core"."core_outbox"
    WHERE payload->>'organizationId' = ${org} AND payload->>'entityId' = ${entityId}
    ORDER BY id`;

describe("reaction events", () => {
  it("records reaction.added once, and a webhook, with no audit entry", async () => {
    const { org, me, session, id } = await room();

    await addReaction(id, me.token, "👍");
    await addReaction(id, me.token, "👍");

    const events = await eventsOf(session.id);
    expect(events.map((e) => e.type)).toEqual(["reaction.added"]);
    expect(events[0].actorId).toBe(me.principalId);
    expect(
      EVENT_TYPES["reaction.added"].payload.parse(events[0].payload)
    ).toEqual({
      sessionId: session.id,
      messageId: id,
      principalId: me.principalId,
      emoji: "👍",
    });
    const rows = await outbox(org, id);
    expect(rows.map((r) => r.payload.eventType)).toEqual([
      "homileo.message.created",
      "homileo.reaction.added",
    ]);
    expect(rows.every((r) => r.destination === "webhook")).toBe(true);
  });

  it("records reaction.removed once and nothing for a 404", async () => {
    const { me, session, id } = await room();
    await addReaction(id, me.token, ":ok:");

    const first = await removeReaction(id, me.token, ":ok:");
    const second = await removeReaction(id, me.token, ":ok:");

    expect([first.status, second.status]).toEqual([200, 404]);
    const events = await eventsOf(session.id);
    expect(events.map((e) => e.type)).toEqual([
      "reaction.added",
      "reaction.removed",
    ]);
    expect(
      EVENT_TYPES["reaction.removed"].payload.parse(events[1].payload)
    ).toMatchObject({ messageId: id, emoji: ":ok:" });
  });

  it("records nothing for a refused reaction", async () => {
    const { org, session, id } = await room();
    const other = await signIn(org);

    await addReaction(id, other.token, "👍");

    expect(await eventsOf(session.id)).toEqual([]);
  });
});
