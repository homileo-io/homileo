// @module-tag int
// @module-tag spaces
// @module-tag security
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
const patch = (token: string, id: string, body: unknown = { name: "New" }) =>
  fetchJson("PATCH", `${url}/v1/spaces/${id}`, token, body);

describe("/v1/spaces/:spaceId access", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("answers 404 to a non-member of a members space, on GET and PATCH", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const { token } = await api.actor(org);

    expect((await get(token, space.id)).status).toBe(404);
    expect((await patch(token, space.id)).status).toBe(404);
  });

  it("answers 403 to a member and 200 to a moderator", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const member = await api.actor(org);
    const moderator = await api.actor(org);
    await fixtures.member(space, member.principal, "member");
    await fixtures.member(space, moderator.principal, "moderator");

    const refused = await patch(member.token, space.id);
    const allowed = await patch(moderator.token, space.id);

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("forbidden");
    expect(allowed.status).toBe(200);
  });

  it("answers 403 to a reader of a public space who is not a member", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org, visibility: "public" });
    const { token } = await api.actor(org);

    expect((await get(token, space.id)).status).toBe(200);
    expect((await patch(token, space.id)).status).toBe(403);
  });

  it("answers 200 to the holder of a kind's moderate grant, 404 to one with a read grant on another kind", async () => {
    const org = api.organization();
    const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
      grants: [
        { permission: "spaces-test.moderate", access: "moderate" },
        { permission: "spaces-test.read", access: "read" },
      ],
    });
    const space = await fixtures.space({ org, kind });
    const moderator = await api.actor(org, ["spaces-test.moderate"]);
    const reader = await api.actor(org, ["spaces-test.read"]);
    const outsider = await api.actor(org, ["other.moderate"]);

    expect((await patch(moderator.token, space.id)).status).toBe(200);
    expect((await get(reader.token, space.id)).status).toBe(200);
    expect((await patch(reader.token, space.id)).status).toBe(403);
    expect((await patch(outsider.token, space.id)).status).toBe(404);
  });

  it("answers 200 to an admin of the organization and 404 to an admin of another", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const admin = await api.actor(org, ["homileo.chat.admin"]);
    const foreign = await api.actor(api.organization(), ["homileo.chat.admin"]);

    expect((await patch(admin.token, space.id)).status).toBe(200);
    expect((await get(foreign.token, space.id)).status).toBe(404);
    expect((await patch(foreign.token, space.id)).status).toBe(404);
  });

  it("does not let a removed member keep reading a members space", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const member = await api.actor(org);
    await fixtures.member(space, member.principal);
    expect((await get(member.token, space.id)).status).toBe(200);

    await prisma.spaceMember.deleteMany({ where: { spaceId: space.id } });

    expect((await get(member.token, space.id)).status).toBe(404);
  });
});
