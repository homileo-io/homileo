// @module-tag int
// @module-tag sync
// @module-tag access
import { fetchJson, type JsonResponse } from "../../../support/http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../support/spaceApi.js";
import { drainSync, syncHead } from "../../../support/sync.js";
import { sendMessage } from "../../../support/messageApi.js";
import { personToken } from "../../../support/tokens.js";
import { startV1App } from "../../../support/v1App.js";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const api = spaceApiFixtures();
const { fixtures } = api;
let org = "";
type Actor = Awaited<ReturnType<typeof api.actor>>;
let alice: Actor;
let bob: Actor;
// Serves the kind this file provisions; the shared server's kind cache would not see it.
let app: Awaited<ReturnType<typeof startV1App>>;

beforeAll(async () => {
  app = await startV1App();
  org = api.organization();
  alice = await api.actor(org);
  bob = await api.actor(org);
});

afterAll(async () => {
  await app.close();
  await api.cleanup();
});

const ofSession = (events: JsonResponse["body"][], sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId);

describe("GET /v1/sync access", () => {
  it("never returns another organization's events, even of the caller's own sessions", async () => {
    const otherOrg = api.organization();
    const aliceThere = personToken({
      userId: alice.principal.tereoUserId!,
      org: otherOrg,
    });
    const bobThere = personToken({
      userId: bob.principal.tereoUserId!,
      org: otherOrg,
    });
    const session = await fixtures.session({ org: otherOrg });
    await fixtures.participant(session, alice.principal);
    await fixtures.participant(session, bob.principal);
    const here = await syncHead(alice.token);
    const there = await syncHead(aliceThere);
    const sent = await sendMessage(session.id, bobThere, { body: "elsewhere" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    const fromHere = await drainSync(alice.token, here);
    const fromThere = await drainSync(aliceThere, there);

    expect(fromHere.events.filter((e) => e.organizationId !== org)).toEqual([]);
    expect(ofSession(fromThere.events, session.id).map((e) => e.type)).toEqual([
      "message.created",
    ]);
  });

  it("returns a public space's session the caller is not in only when named in sessionIds", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.member(space, bob.principal);
    await fixtures.participant(session, bob.principal);
    const since = await syncHead(alice.token);
    await sendMessage(session.id, bob.token, { body: "in public" });

    const unnamed = await drainSync(alice.token, since);
    const named = await drainSync(alice.token, since, {
      sessionIds: session.id,
    });

    expect(ofSession(unnamed.events, session.id)).toEqual([]);
    expect(ofSession(named.events, session.id).map((e) => e.type)).toEqual([
      "message.created",
    ]);
  });

  it("returns a message mentioning a space member who is not in its session, and not the others", async () => {
    const space = await fixtures.space({ org, visibility: "members" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.member(space, bob.principal);
    await fixtures.member(space, alice.principal);
    await fixtures.participant(session, bob.principal);
    const since = await syncHead(alice.token);
    await sendMessage(session.id, bob.token, { body: "no mention" });
    const sent = await sendMessage(session.id, bob.token, {
      body: `ping <@${alice.principal.id}>`,
    });

    const { events } = await drainSync(alice.token, since);

    expect(
      ofSession(events, session.id).map((e) => e.payload.message.id)
    ).toEqual([sent.body.message.id]);
  });

  it("returns a members space's events only while the caller can read it", async () => {
    const space = await fixtures.space({ org, visibility: "members" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.member(space, bob.principal, "owner");
    await fixtures.member(space, alice.principal);
    await fixtures.participant(session, bob.principal);
    await fixtures.participant(session, alice.principal);
    const since = await syncHead(alice.token);
    await sendMessage(session.id, bob.token, { body: "before" });
    const before = await drainSync(alice.token, since);
    expect(ofSession(before.events, session.id)).toHaveLength(1);

    const removed = await fetchJson(
      "DELETE",
      `${env.PUBLIC_URL}/v1/spaces/${space.id}/members/${alice.principal.id}`,
      bob.token
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const after = await drainSync(alice.token, since);

    const mine = after.events.filter(
      (e) => e.spaceId === space.id || e.sessionId === session.id
    );
    expect(mine.map((e) => e.type).sort()).toEqual([
      "session.access_revoked",
      "space.access_revoked",
    ]);
    for (const e of mine) {
      expect(e.payload.principalId).toBe(alice.principal.id);
    }
  });

  it("drops a revocation the caller can still read past, and keeps it for one who cannot", async () => {
    const permission = `sync-test.cases.read`;
    const kind = await api.kind(`sync-test:${uuidv7().slice(-8)}`, {
      grants: [{ permission, access: "read" }],
    });
    const space = await fixtures.space({ org, kind, visibility: "members" });
    const session = await fixtures.session({ space, access: "members" });
    const granted = await api.actor(org, [permission]);
    await fixtures.member(space, bob.principal, "owner");
    await fixtures.participant(session, bob.principal, "owner");
    await fixtures.participant(session, granted.principal);
    await fixtures.participant(session, alice.principal);
    const grantedSince = await syncHead(granted.token, app.url);
    const aliceSince = await syncHead(alice.token, app.url);

    for (const who of [granted, alice]) {
      const removed = await fetchJson(
        "DELETE",
        `${app.url}/v1/sessions/${session.id}/participants/${who.principal.id}`,
        bob.token
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    }
    const toGranted = ofSession(
      (await drainSync(granted.token, grantedSince, {}, app.url)).events,
      session.id
    );
    const toAlice = ofSession(
      (await drainSync(alice.token, aliceSince, {}, app.url)).events,
      session.id
    );

    expect(toGranted.map((e) => e.type)).not.toContain(
      "session.access_revoked"
    );
    expect(
      toGranted.map((e) => [e.type, e.payload.principalId])
    ).toContainEqual(["session.participant_removed", granted.principal.id]);
    expect(toAlice.map((e) => [e.type, e.payload.principalId])).toEqual([
      ["session.access_revoked", alice.principal.id],
    ]);
  });
});
