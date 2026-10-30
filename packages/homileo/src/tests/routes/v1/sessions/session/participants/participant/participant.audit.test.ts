// @module-tag int
// @module-tag sessions
// @module-tag events
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../../../env.js";
import { v7 as uuidv7 } from "uuid";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const org = uuidv7();
const url = (s: string, p: string) =>
  `${env.PUBLIC_URL}/v1/sessions/${s}/participants/${p}`;
const types = async (sessionId: string) =>
  (
    await prisma.event.findMany({
      where: { sessionId },
      orderBy: { id: "asc" },
    })
  ).map((e) => e.type);
const audits = (entityId: string) =>
  prisma.$queryRaw<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM "core"."core_outbox"
    WHERE destination = 'audit' AND payload->>'entityId' = ${entityId}`;

afterAll(async () => {
  await purgeOrganizations([org]);
  await fixtures.cleanup();
});

describe("participant events", () => {
  it("records participant_added and space.member_added (audited) for a join, and nothing for a repeat", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "open",
    });
    const s = await fixtures.session({ org, space, access: "space" });
    const me = await signIn(org);

    await fetchJson("PUT", url(s.id, me.principalId), me.token);
    await fetchJson("PUT", url(s.id, me.principalId), me.token);

    expect(await types(s.id)).toEqual(["session.participant_added"]);
    const added = await prisma.event.findFirstOrThrow({
      where: { spaceId: space.id, type: "space.member_added" },
    });
    expect(added.payload).toMatchObject({
      spaceId: space.id,
      member: { principalId: me.principalId, role: "member" },
    });
    const log = await audits(space.id);
    expect(log).toHaveLength(1);
    expect(log[0].payload).toMatchObject({
      action: "CREATE",
      userId: me.tereoUserId,
    });
  });

  it("records participant_removed, access_revoked and a DELETE audit when an owner removes a member", async () => {
    const s = await fixtures.session({ org });
    const owner = await signIn(org);
    const victim = await fixtures.principal();
    await fixtures.participant(s, { id: owner.principalId }, "owner");
    await fixtures.participant(s, victim);

    await fetchJson("DELETE", url(s.id, victim.id), owner.token);

    const events = await prisma.event.findMany({
      where: { sessionId: s.id },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "session.participant_removed",
      "session.access_revoked",
    ]);
    expect(events[0].payload).toEqual({
      sessionId: s.id,
      principalId: victim.id,
    });
    expect(events[1].payload).toEqual({
      principalId: victim.id,
      sessionId: s.id,
    });
    expect(events[0].actorId).toBe(owner.principalId);
    const log = await audits(s.id);
    expect(log).toHaveLength(1);
    expect(log[0].payload).toMatchObject({
      action: "DELETE",
      entityType: "session",
      userId: owner.tereoUserId,
    });
  });

  it("records no audit entry and its own access facts when someone leaves", async () => {
    const s = await fixtures.session({ org });
    const me = await signIn(org);
    await fixtures.participant(s, { id: me.principalId }, "owner");

    await fetchJson("DELETE", url(s.id, me.principalId), me.token);

    expect(await types(s.id)).toEqual([
      "session.participant_removed",
      "session.access_revoked",
    ]);
    expect(await audits(s.id)).toHaveLength(0);
  });

  it("revokes no access in a public space's space session", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });
    const mod = await signIn(org);
    const me = await signIn(org);
    await fixtures.member(space, { id: mod.principalId }, "moderator");
    await fixtures.participant(s, { id: me.principalId });

    await fetchJson("DELETE", url(s.id, me.principalId), me.token);
    const other = await fixtures.principal();
    await fixtures.participant(s, other);
    await fetchJson("DELETE", url(s.id, other.id), mod.token);

    expect(await types(s.id)).toEqual([
      "session.participant_removed",
      "session.participant_removed",
    ]);
  });

  it("revokes access for a non-member removed from a members-visibility space's space session", async () => {
    const space = await fixtures.space({ org, visibility: "members" });
    const s = await fixtures.session({ org, space, access: "space" });
    const mod = await signIn(org);
    const stray = await fixtures.principal();
    await fixtures.member(space, { id: mod.principalId }, "moderator");
    await fixtures.participant(s, stray);

    await fetchJson("DELETE", url(s.id, stray.id), mod.token);

    expect(await types(s.id)).toEqual([
      "session.participant_removed",
      "session.access_revoked",
    ]);
  });
});
