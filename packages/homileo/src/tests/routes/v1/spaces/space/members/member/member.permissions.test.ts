// @module-tag int
// @module-tag spaces
// @module-tag security
import { spaceApiFixtures } from "../../../../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../../support/v1App.js";
import { fetchJson } from "../../../../../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

type Role = "owner" | "moderator" | "member";
type Caller = Role | "admin" | "grant" | "reader";

/** A space with a second owner, so the last-owner rule never decides these rows. */
const arrange = async (o: { archived?: boolean } = {}) => {
  const org = api.organization();
  const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`, {
    grants: [{ permission: "spaces-test.moderate", access: "moderate" }],
  });
  const creator = await api.actor(org);
  const space = await fixtures.space({
    org,
    kind,
    visibility: "public",
    archived: o.archived,
    createdBy: creator.principal,
  });
  await fixtures.member(space, creator.principal, "owner");
  const callers: Record<Caller, Awaited<ReturnType<typeof api.actor>>> = {
    owner: await api.actor(org),
    moderator: await api.actor(org),
    member: await api.actor(org),
    admin: await api.actor(org, ["homileo.chat.admin"]),
    grant: await api.actor(org, ["spaces-test.moderate"]),
    reader: await api.actor(org),
  };
  await fixtures.member(space, callers.owner.principal, "owner");
  await fixtures.member(space, callers.moderator.principal, "moderator");
  await fixtures.member(space, callers.member.principal, "member");
  return { org, space, callers };
};

const call = async (
  who: Caller,
  action: "add" | "change" | "remove",
  target: Role | null,
  o: { archived?: boolean } = {}
) => {
  const { org, space, callers } = await arrange(o);
  const victim = await api.actor(org);
  if (target) await fixtures.member(space, victim.principal, target);
  const base = `${url}/v1/spaces/${space.id}/members/${victim.principal.id}`;
  const token = callers[who].token;
  if (action === "remove") return fetchJson("DELETE", base, token);
  return fetchJson("PUT", base, token, {
    role: action === "add" ? "member" : "moderator",
  });
};

describe("member changes by role (decision 5)", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it.each([
    ["owner", "add", null, 201],
    ["moderator", "add", null, 201],
    ["grant", "add", null, 201],
    ["admin", "add", null, 201],
    ["member", "add", null, 403],
    ["reader", "add", null, 403],
    ["owner", "remove", "member", 204],
    ["moderator", "remove", "member", 204],
    ["grant", "remove", "member", 204],
    ["member", "remove", "member", 403],
    ["owner", "remove", "moderator", 204],
    ["admin", "remove", "moderator", 204],
    ["moderator", "remove", "moderator", 403],
    ["grant", "remove", "moderator", 403],
    ["owner", "change", "member", 200],
    ["admin", "change", "member", 200],
    ["moderator", "change", "member", 403],
    ["grant", "change", "member", 403],
    ["member", "change", "member", 403],
    ["reader", "change", "member", 403],
    ["moderator", "remove", "owner", 403],
    ["owner", "remove", "owner", 204],
  ] as const)("%s %s %s -> %i", async (who, action, target, status) => {
    const res = await call(who, action, target);

    expect(res.status).toBe(status);
  });

  it("lets a moderator add a moderator only through an owner", async () => {
    const { org, space, callers } = await arrange();
    const victim = await api.actor(org);
    const path = `${url}/v1/spaces/${space.id}/members/${victim.principal.id}`;

    const refused = await fetchJson("PUT", path, callers.moderator.token, {
      role: "moderator",
    });
    const allowed = await fetchJson("PUT", path, callers.owner.token, {
      role: "moderator",
    });

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(201);
  });

  it("lets a member leave; a reader has nothing to leave", async () => {
    const { space, callers } = await arrange();
    const path = (id: string) => `${url}/v1/spaces/${space.id}/members/${id}`;

    const member = await fetchJson(
      "DELETE",
      path(callers.member.principal.id),
      callers.member.token
    );
    const reader = await fetchJson(
      "DELETE",
      path(callers.reader.principal.id),
      callers.reader.token
    );

    expect(member.status).toBe(204);
    expect(reader.status).toBe(404);
  });

  it("refuses changes to an archived space, but not leaving it", async () => {
    const { space, callers } = await arrange({ archived: true });
    const victim = await api.actor(space.organizationId);
    const add = await fetchJson(
      "PUT",
      `${url}/v1/spaces/${space.id}/members/${victim.principal.id}`,
      callers.owner.token,
      { role: "member" }
    );
    const leave = await fetchJson(
      "DELETE",
      `${url}/v1/spaces/${space.id}/members/${callers.member.principal.id}`,
      callers.member.token
    );

    expect(add.status).toBe(403);
    expect(leave.status).toBe(204);
  });

  it("answers 404 to a caller who cannot read the space", async () => {
    const org = api.organization();
    const space = await fixtures.space({ org });
    const outsider = await api.actor(org);
    const target = await api.actor(org);
    await fixtures.member(space, target.principal);
    const foreign = await api.actor(api.organization());
    const path = `${url}/v1/spaces/${space.id}/members/${target.principal.id}`;

    expect((await fetchJson("DELETE", path, outsider.token)).status).toBe(404);
    expect(
      (await fetchJson("PUT", path, foreign.token, { role: "member" })).status
    ).toBe(404);
    expect(
      await prisma.spaceMember.count({ where: { spaceId: space.id } })
    ).toBe(1);
  });
});
