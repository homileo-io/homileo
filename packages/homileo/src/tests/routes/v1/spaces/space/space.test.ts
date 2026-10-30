// @module-tag int
// @module-tag spaces
import { spaceApiFixtures, startV1App } from "../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const get = (token: string, id: string) =>
  fetchJson("GET", `${url}/v1/spaces/${id}`, token);
const patch = (token: string, id: string, body: unknown) =>
  fetchJson("PATCH", `${url}/v1/spaces/${id}`, token, body);

/** A space with an owner, in a fresh organization. */
const ownedSpace = async (o: { kind?: string; archived?: boolean } = {}) => {
  const org = api.organization();
  const owner = await api.actor(org);
  const space = await fixtures.space({ ...o, org, createdBy: owner.principal });
  await fixtures.member(space, owner.principal, "owner");
  return { org, owner, space };
};

describe("/v1/spaces/:spaceId", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  describe("GET", () => {
    it("returns the space and the caller's role", async () => {
      const { owner, space } = await ownedSpace();

      const res = await get(owner.token, space.id);

      expect(res.status).toBe(200);
      expect(res.body.space).toMatchObject({ id: space.id, name: "fixture" });
      expect(res.body.role).toBe("owner");
    });

    it("returns a null role to a reader who is not a member", async () => {
      const { org, space } = await ownedSpace();
      await prisma.space.update({
        where: { id: space.id },
        data: { visibility: "public" },
      });
      const { token } = await api.actor(org);

      const res = await get(token, space.id);

      expect(res.status).toBe(200);
      expect(res.body.role).toBeNull();
    });

    it("still returns an archived space", async () => {
      const { owner, space } = await ownedSpace({ archived: true });

      const res = await get(owner.token, space.id);

      expect(res.status).toBe(200);
      expect(res.body.space.archivedAt).not.toBeNull();
    });

    it("returns 404 for a space of another organization, even a public one", async () => {
      const { space } = await ownedSpace();
      await prisma.space.update({
        where: { id: space.id },
        data: { visibility: "public" },
      });
      const { token } = await api.actor(api.organization());

      const res = await get(token, space.id);

      expect(res.status).toBe(404);
    });

    it("returns 404 for an unknown id and 400 for one that is not a UUID", async () => {
      const { token } = await api.actor(api.organization());

      expect((await get(token, uuidv7())).status).toBe(404);
      const bad = await get(token, "not-a-uuid");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_request");
    });
  });

  describe("PATCH", () => {
    it("updates the given fields and leaves the rest", async () => {
      const { owner, space } = await ownedSpace();

      const res = await patch(owner.token, space.id, {
        name: "  Renamed ",
        description: "About",
        visibility: "public",
      });

      expect(res.status).toBe(200);
      expect(res.body.space).toMatchObject({
        name: "Renamed",
        description: "About",
        visibility: "public",
        joinPolicy: "invite",
      });
      expect(
        (await prisma.space.findUniqueOrThrow({ where: { id: space.id } })).name
      ).toBe("Renamed");
    });

    it("replaces metadata whole", async () => {
      const { owner, space } = await ownedSpace();
      await patch(owner.token, space.id, { metadata: { a: 1, b: 2 } });

      const res = await patch(owner.token, space.id, { metadata: { c: 3 } });

      expect(res.body.space.metadata).toEqual({ c: 3 });
    });

    it("returns 400 for an empty body, an unknown field and a bad value", async () => {
      const { owner, space } = await ownedSpace();

      for (const body of [{}, { archivedAt: null }, { name: "" }]) {
        const res = await patch(owner.token, space.id, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_request");
      }
    });

    it("refuses a setting the kind does not let spaces override", async () => {
      const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
        overridable: ["visibility"],
      });
      const { owner, space } = await ownedSpace({ kind });

      const refused = await patch(owner.token, space.id, {
        postPolicy: "moderators",
      });
      const allowed = await patch(owner.token, space.id, {
        visibility: "public",
      });

      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("setting_not_overridable");
      expect(allowed.status).toBe(200);
    });

    it("accepts a state of the kind, clears it with null, and refuses others", async () => {
      const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
        states: ["open"],
      });
      const { owner, space } = await ownedSpace({ kind });

      const set = await patch(owner.token, space.id, { state: "open" });
      const cleared = await patch(owner.token, space.id, { state: null });
      const bad = await patch(owner.token, space.id, { state: "gone" });

      expect(set.body.space.state).toBe("open");
      expect(cleared.body.space.state).toBeNull();
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_state");
    });

    it("returns 409 external_ref_taken when the new ref belongs to another space", async () => {
      const { org, owner, space } = await ownedSpace();
      const taken = await fixtures.space({ org });
      await prisma.space.update({
        where: { id: taken.id },
        data: { externalRef: "taken" },
      });

      const res = await patch(owner.token, space.id, { externalRef: "taken" });
      const free = await patch(owner.token, space.id, { externalRef: "free" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("external_ref_taken");
      expect(free.status).toBe(200);
    });

    it("returns 409 resource_archived for an archived space", async () => {
      const { owner, space } = await ownedSpace({ archived: true });

      const res = await patch(owner.token, space.id, { name: "x" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("resource_archived");
    });

    it("returns the space unchanged for a repeat that changes nothing", async () => {
      const { owner, space } = await ownedSpace();
      const first = await patch(owner.token, space.id, { name: "Same" });

      const again = await patch(owner.token, space.id, { name: "Same" });

      expect(again.status).toBe(200);
      expect(again.body.space.updatedAt).toBe(first.body.space.updatedAt);
    });
  });
});
