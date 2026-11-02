// @module-tag int
// @module-tag sync
// @module-tag race
import { catchUp, syncHead, syncTail } from "../../../support/sync.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../support/spaceApi.js";
import type { JsonResponse } from "../../../support/http.js";
import {
  permutations,
  reactionsAfter,
} from "../../../support/pure/reactions.js";
import {
  addReaction,
  deleteMessage,
  editMessage,
  getMessage,
  removeReaction,
  sendMessage,
} from "../../../support/messageApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let org = "";
let alice: Awaited<ReturnType<typeof api.actor>>;
let bob: Awaited<ReturnType<typeof api.actor>>;

beforeAll(async () => {
  org = api.organization();
  alice = await api.actor(org);
  bob = await api.actor(org);
});

afterAll(async () => {
  await api.cleanup();
});

const groupOfTwo = async () => {
  const session = await fixtures.session({ org, createdBy: alice.principal });
  await fixtures.participant(session, alice.principal, "owner");
  await fixtures.participant(session, bob.principal);
  return session;
};

// Up to now: an open transaction elsewhere on the server must not cut the read short.
const catchUpNow = async (since: string) =>
  (await catchUp(bob.token, since, await syncTail())).events;

const restReactions = async (messageId: string) => {
  const rest = await getMessage(messageId, bob.token);
  expect(rest.status, JSON.stringify(rest.body)).toBe(200);
  const { reactions, reactionSeq } = rest.body.message;
  return { reactions, reactionSeq };
};

const ok = (r: JsonResponse) => {
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r;
};

/**
 * Two transactions racing for the session lock commit the same events whichever wins:
 * the log's (tx_id) order is the only thing a race changes. So every order of the
 * events the client may meet must end at the REST state.
 */
const expectEveryOrderToConverge = async (
  events: JsonResponse["body"][],
  messageId: string
) => {
  const rest = await restReactions(messageId);
  for (const order of permutations(events)) {
    expect(reactionsAfter(order, messageId)).toEqual(rest);
  }
  return rest;
};

describe("GET /v1/sync: reaction state converges whatever the log order", () => {
  it("a reaction racing an edit, which a delta count would apply twice", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const id = ok(await sendMessage(session.id, alice.token, { body: "m" }))
      .body.message.id;
    ok(await addReaction(id, bob.token, "👍"));
    ok(await editMessage(id, alice.token, { body: "m2" }));

    const events = await catchUpNow(since);

    expect(events.map((e) => e.type)).toEqual([
      "message.created",
      "reaction.added",
      "message.edited",
    ]);
    // The racing order: the edit's tx_id below the reaction's, its view already counting it.
    const [created, reacted, edited] = events;
    expect(edited.payload.message.reactions).toEqual(reacted.payload.reactions);
    expect(edited.payload.message.reactionSeq).toBe(1);
    const rest = await expectEveryOrderToConverge(events, id);
    expect(rest.reactions).toMatchObject([{ emoji: "👍", count: 1 }]);
    expect(reactionsAfter([created, edited, reacted], id).reactions).toEqual(
      rest.reactions
    );
  });

  it("a reaction racing a delete", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const id = ok(await sendMessage(session.id, alice.token, { body: "m" }))
      .body.message.id;
    ok(await addReaction(id, bob.token, "👍"));
    ok(await deleteMessage(id, alice.token));

    const events = await catchUpNow(since);

    expect(events.map((e) => e.type)).toEqual([
      "message.created",
      "reaction.added",
      "message.deleted",
    ]);
    const rest = await expectEveryOrderToConverge(events, id);
    expect(rest).toEqual({ reactions: [], reactionSeq: 2 });
  });

  it("reactions racing each other and an edit, an add and a removal among them", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const id = ok(await sendMessage(session.id, alice.token, { body: "m" }))
      .body.message.id;
    ok(await addReaction(id, bob.token, "👍"));
    ok(await editMessage(id, alice.token, { body: "m2" }));
    ok(await addReaction(id, alice.token, "🎉"));
    ok(await removeReaction(id, bob.token, "👍"));

    const events = await catchUpNow(since);

    expect(events).toHaveLength(5);
    const rest = await expectEveryOrderToConverge(events, id);
    expect(rest.reactions).toMatchObject([{ emoji: "🎉", count: 1 }]);
    expect(rest.reactionSeq).toBe(3);
  });

  it("starts from a REST view the client already holds", async () => {
    const session = await groupOfTwo();
    const id = ok(await sendMessage(session.id, alice.token, { body: "m" }))
      .body.message.id;
    ok(await addReaction(id, bob.token, "👍"));
    const held = await restReactions(id);
    const since = await syncHead(bob.token);
    ok(await addReaction(id, alice.token, "👍"));
    ok(await editMessage(id, alice.token, { body: "m2" }));

    const events = await catchUpNow(since);

    const rest = await restReactions(id);
    for (const order of permutations(events)) {
      expect(reactionsAfter(order, id, held)).toEqual(rest);
    }
    expect(rest.reactions).toMatchObject([{ emoji: "👍", count: 2 }]);
  });

  it("real concurrent reactions and edits: one summary per seq, the highest the REST state", async () => {
    const session = await groupOfTwo();
    const since = await syncHead(bob.token);
    const id = ok(await sendMessage(session.id, alice.token, { body: "m" }))
      .body.message.id;
    const emojis = ["👍", "🎉", "🚀", "👀"];
    await Promise.all([
      ...emojis.map(async (emoji) =>
        ok(await addReaction(id, bob.token, emoji))
      ),
      ...emojis.map(async (emoji) =>
        ok(await addReaction(id, alice.token, emoji))
      ),
      ...[1, 2, 3].map(async (n) =>
        ok(await editMessage(id, alice.token, { body: `m${n}` }))
      ),
    ]);
    await Promise.all(
      emojis
        .slice(0, 2)
        .map(async (emoji) => ok(await removeReaction(id, bob.token, emoji)))
    );

    const events = await catchUpNow(since);

    const bySeq = new Map<number, unknown>();
    for (const e of events) {
      const source = e.payload.message ?? e.payload;
      const seen = bySeq.get(source.reactionSeq);
      if (seen !== undefined) expect(source.reactions).toEqual(seen);
      bySeq.set(source.reactionSeq, source.reactions);
    }
    const rest = await restReactions(id);
    expect(rest.reactionSeq).toBe(10);
    expect(reactionsAfter(events, id)).toEqual(rest);
    expect(reactionsAfter([...events].reverse(), id)).toEqual(rest);
  });
});
