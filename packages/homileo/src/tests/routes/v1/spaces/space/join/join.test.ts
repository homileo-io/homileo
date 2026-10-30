// @module-tag int
// @module-tag spaces
import type { JoinPolicy } from "../../../../../../../prisma/generated/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const join = (token: string, spaceId: string) =>
  fetchJson("POST", `${url}/v1/spaces/${spaceId}/join`, token);

const setup = async (
  joinPolicy: JoinPolicy,
  visibility: "public" | "members" = "public"
) => {
  const org = api.organization();
  const space = await fixtures.space({ org, joinPolicy, visibility });
  const joiner = await api.actor(org);
  return { org, space, joiner };
};

describe("POST /v1/spaces/:spaceId/join", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("joins an open space as a member and records space.member_added", async () => {
    const { org, space, joiner } = await setup("open");

    const res = await join(joiner.token, space.id);

    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({
      spaceId: space.id,
      principalId: joiner.principal.id,
      role: "member",
    });
    const events = await prisma.event.findMany({
      where: { organizationId: org },
    });
    expect(events.map((e) => e.type)).toEqual(["space.member_added"]);
  });

  it("answers 200 with the membership to someone already in, and records nothing", async () => {
    const { org, space, joiner } = await setup("invite");
    await fixtures.member(space, joiner.principal, "moderator");

    const res = await join(joiner.token, space.id);

    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe("moderator");
    expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
      0
    );
  });

  it("files a pending request on a request space, and a repeat returns the same one", async () => {
    const { org, space, joiner } = await setup("request");

    const first = await join(joiner.token, space.id);
    const second = await join(joiner.token, space.id);

    expect(first.status).toBe(202);
    expect(first.body.request).toMatchObject({
      spaceId: space.id,
      principalId: joiner.principal.id,
      status: "pending",
      decidedBy: null,
    });
    expect(second.status).toBe(202);
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(
      await prisma.spaceJoinRequest.count({ where: { spaceId: space.id } })
    ).toBe(1);
    const events = await prisma.event.findMany({
      where: { organizationId: org },
    });
    expect(events.map((e) => e.type)).toEqual(["space.join_requested"]);
    expect(events[0].payload).toEqual({ request: first.body.request });
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, userId: joiner.principal.id },
      })
    ).toBe(0);
  });

  it("allows a new request after the earlier one was decided", async () => {
    const { space, joiner } = await setup("request");
    await prisma.spaceJoinRequest.create({
      data: {
        spaceId: space.id,
        userId: joiner.principal.id,
        status: "denied",
      },
    });

    const res = await join(joiner.token, space.id);

    expect(res.status).toBe(202);
    expect(res.body.request.status).toBe("pending");
  });

  it("answers 403 on an invite space the caller can read", async () => {
    const { space, joiner } = await setup("invite");

    const res = await join(joiner.token, space.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("answers 403 on an archived space", async () => {
    const org = api.organization();
    const space = await fixtures.space({
      org,
      joinPolicy: "open",
      visibility: "public",
      archived: true,
    });
    const joiner = await api.actor(org);

    expect((await join(joiner.token, space.id)).status).toBe(403);
  });

  it("answers 404 on a members space the caller cannot read, whatever its join policy", async () => {
    const { space, joiner } = await setup("open", "members");
    const foreign = await api.actor(api.organization());

    expect((await join(joiner.token, space.id)).status).toBe(404);
    expect((await join(foreign.token, space.id)).status).toBe(404);
  });

  it("answers 400 to a malformed id", async () => {
    const { joiner } = await setup("open");

    expect((await join(joiner.token, "nope")).status).toBe(400);
  });
});
