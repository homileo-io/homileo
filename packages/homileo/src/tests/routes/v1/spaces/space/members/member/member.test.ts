// @module-tag int
// @module-tag spaces
import { readableSession } from "../../../../../../../utils/access.js";
import type { Caller } from "../../../../../../../middleware/auth.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../../support/http.js";
import { v7 as uuidv7 } from "uuid";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const put = (token: string, spaceId: string, who: string, body: unknown) =>
  fetchJson("PUT", `${url}/v1/spaces/${spaceId}/members/${who}`, token, body);
const del = (token: string, spaceId: string, who: string) =>
  fetchJson("DELETE", `${url}/v1/spaces/${spaceId}/members/${who}`, token);
const get = (token: string, spaceId: string) =>
  fetchJson("GET", `${url}/v1/spaces/${spaceId}`, token);

const setup = async (o: { visibility?: "public" | "members" } = {}) => {
  const org = api.organization();
  const owner = await api.actor(org);
  const space = await fixtures.space({
    org,
    createdBy: owner.principal,
    visibility: o.visibility,
  });
  await fixtures.member(space, owner.principal, "owner");
  return { org, owner, space };
};

const roleOf = async (spaceId: string, userId: string) =>
  (
    await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId } },
    })
  )?.role ?? null;

describe("/v1/spaces/:spaceId/members/:principalId", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  describe("PUT", () => {
    it("adds a member with 201", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);

      const res = await put(owner.token, space.id, target.principal.id, {
        role: "moderator",
      });

      expect(res.status).toBe(201);
      expect(res.body.member).toMatchObject({
        spaceId: space.id,
        principalId: target.principal.id,
        role: "moderator",
      });
      expect(await roleOf(space.id, target.principal.id)).toBe("moderator");
    });

    it("changes a role with 200", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "member");

      const res = await put(owner.token, space.id, target.principal.id, {
        role: "moderator",
      });

      expect(res.status).toBe(200);
      expect(res.body.member.role).toBe("moderator");
      expect(await roleOf(space.id, target.principal.id)).toBe("moderator");
    });

    it("answers 200 unchanged to the same role, and records nothing", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "moderator");

      const res = await put(owner.token, space.id, target.principal.id, {
        role: "moderator",
      });

      expect(res.status).toBe(200);
      expect(res.body.member.role).toBe("moderator");
      expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
        0
      );
    });

    it("answers 200 unchanged to a moderator or member repeating a role, and records nothing", async () => {
      const { org, space } = await setup();
      const target = await api.actor(org);
      const moderator = await api.actor(org);
      const plain = await api.actor(org);
      await fixtures.member(space, target.principal, "member");
      await fixtures.member(space, moderator.principal, "moderator");
      await fixtures.member(space, plain.principal, "member");

      for (const caller of [moderator, plain]) {
        const res = await put(caller.token, space.id, target.principal.id, {
          role: "member",
        });
        expect(res.status).toBe(200);
        expect(res.body.member.role).toBe("member");
      }
      expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
        0
      );
    });

    it("answers 404 to an unknown principal and 400 to bad input", async () => {
      const { owner, space } = await setup();

      expect(
        (await put(owner.token, space.id, uuidv7(), { role: "member" })).status
      ).toBe(404);
      expect(
        (await put(owner.token, space.id, "nope", { role: "member" })).status
      ).toBe(400);
      expect(
        (await put(owner.token, space.id, uuidv7(), { role: "boss" })).status
      ).toBe(400);
      expect((await put(owner.token, space.id, uuidv7(), {})).status).toBe(400);
    });

    it("refuses to demote the last owner", async () => {
      const { owner, space } = await setup();

      const res = await put(owner.token, space.id, owner.principal.id, {
        role: "member",
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("last_owner");
      expect(await roleOf(space.id, owner.principal.id)).toBe("owner");
    });

    it("lets an owner step down when another owner remains", async () => {
      const { org, owner, space } = await setup();
      const other = await api.actor(org);
      await fixtures.member(space, other.principal, "owner");

      const res = await put(owner.token, space.id, owner.principal.id, {
        role: "moderator",
      });

      expect(res.status).toBe(200);
      expect(await roleOf(space.id, owner.principal.id)).toBe("moderator");
    });
  });

  describe("DELETE", () => {
    it("removes a member with 204", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "member");

      const res = await del(owner.token, space.id, target.principal.id);

      expect(res.status).toBe(204);
      expect(await roleOf(space.id, target.principal.id)).toBeNull();
    });

    it("answers 404 for someone who is not a member", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);

      expect(
        (await del(owner.token, space.id, target.principal.id)).status
      ).toBe(404);
    });

    it("refuses to remove or demote the last owner", async () => {
      const { owner, space } = await setup();

      const own = await del(owner.token, space.id, owner.principal.id);

      expect(own.status).toBe(409);
      expect(own.body.error).toBe("last_owner");
      const admin = await api.actor(space.organizationId, [
        "homileo.chat.admin",
      ]);
      const byAdmin = await del(admin.token, space.id, owner.principal.id);
      expect(byAdmin.status).toBe(409);
      expect(byAdmin.body.error).toBe("last_owner");
      expect(await roleOf(space.id, owner.principal.id)).toBe("owner");
    });

    it("lets a member leave", async () => {
      const { org, space } = await setup();
      const leaver = await api.actor(org);
      await fixtures.member(space, leaver.principal, "member");

      const res = await del(leaver.token, space.id, leaver.principal.id);

      expect(res.status).toBe(204);
      expect(await roleOf(space.id, leaver.principal.id)).toBeNull();
    });

    it("takes the member out of the space's sessions", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "member");
      const inside = await fixtures.session({ space });
      const alreadyLeft = await fixtures.session({ space });
      const elsewhere = await fixtures.session({ org });
      await fixtures.participant(inside, target.principal);
      await fixtures.participant(alreadyLeft, target.principal, "member", {
        left: true,
      });
      await fixtures.participant(elsewhere, target.principal);

      await del(owner.token, space.id, target.principal.id);

      const left = (id: string) =>
        prisma.sessionParticipant.findUniqueOrThrow({
          where: {
            sessionId_userId: { sessionId: id, userId: target.principal.id },
          },
        });
      expect((await left(inside.id)).leftAt).not.toBeNull();
      expect((await left(elsewhere.id)).leftAt).toBeNull();
      const events = await prisma.event.findMany({
        where: { organizationId: org, type: "session.participant_removed" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        sessionId: inside.id,
        spaceId: space.id,
        payload: { sessionId: inside.id, principalId: target.principal.id },
      });
    });

    it("cuts off a removed member of a members space at once", async () => {
      const { org, owner, space } = await setup();
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "member");
      const shared = await fixtures.session({ space, access: "space" });
      await fixtures.participant(shared, target.principal);
      const asTarget: Caller = {
        principalId: target.principal.id,
        tereoUserId: target.principal.tereoUserId!,
        isBot: false,
        permissions: [],
        isAdmin: false,
        organizationId: org,
      };
      expect((await get(target.token, space.id)).status).toBe(200);
      await expect(readableSession(asTarget, shared.id)).resolves.toBeDefined();

      await del(owner.token, space.id, target.principal.id);

      expect((await get(target.token, space.id)).status).toBe(404);
      await expect(readableSession(asTarget, shared.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      const revoked = await prisma.event.findMany({
        where: { organizationId: org, type: "space.access_revoked" },
      });
      expect(revoked).toHaveLength(1);
      expect(revoked[0].payload).toEqual({
        principalId: target.principal.id,
        spaceId: space.id,
      });
      const sessionRevoked = await prisma.event.findMany({
        where: { organizationId: org, type: "session.access_revoked" },
      });
      expect(sessionRevoked.map((e) => e.payload)).toEqual([
        { principalId: target.principal.id, sessionId: shared.id },
      ]);
    });

    it("keeps read of a public space and revokes only members-access sessions", async () => {
      const { org, owner, space } = await setup({ visibility: "public" });
      const target = await api.actor(org);
      await fixtures.member(space, target.principal, "member");
      const open = await fixtures.session({ space, access: "space" });
      const closed = await fixtures.session({ space, access: "members" });
      await fixtures.participant(open, target.principal);
      await fixtures.participant(closed, target.principal);

      await del(owner.token, space.id, target.principal.id);

      expect((await get(target.token, space.id)).status).toBe(200);
      expect(
        await prisma.event.count({
          where: { organizationId: org, type: "space.access_revoked" },
        })
      ).toBe(0);
      const sessionRevoked = await prisma.event.findMany({
        where: { organizationId: org, type: "session.access_revoked" },
      });
      expect(sessionRevoked.map((e) => e.payload)).toEqual([
        { principalId: target.principal.id, sessionId: closed.id },
      ]);
    });

    it("judges a leaving caller by their own permissions", async () => {
      const org = api.organization();
      const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
        grants: [{ permission: "spaces-test.read", access: "read" }],
      });
      const owner = await api.actor(org);
      const space = await fixtures.space({
        org,
        kind,
        createdBy: owner.principal,
      });
      await fixtures.member(space, owner.principal, "owner");
      const reader = await api.actor(org, ["spaces-test.read"]);
      await fixtures.member(space, reader.principal, "member");

      await del(reader.token, space.id, reader.principal.id);

      expect((await get(reader.token, space.id)).status).toBe(200);
      expect(
        await prisma.event.count({
          where: { organizationId: org, type: "space.access_revoked" },
        })
      ).toBe(0);
    });
  });
});
