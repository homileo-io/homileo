// @module-tag int
// @module-tag spaces
import { spaceApiFixtures } from "../../../../../../../support/spaceApi.js";
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1App } from "../../../../../../../support/v1App.js";
import { fetchJson } from "../../../../../../../support/http.js";
import { EVENT_TYPES } from "@homileo-io/sdk";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const approve = (token: string, spaceId: string, who: string) =>
  fetchJson(
    "POST",
    `${url}/v1/spaces/${spaceId}/join-requests/${who}/approve`,
    token
  );

const setup = async () => {
  const org = api.organization();
  const moderator = await api.actor(org);
  const space = await fixtures.space({
    org,
    createdBy: moderator.principal,
    joinPolicy: "request",
    visibility: "public",
  });
  await fixtures.member(space, moderator.principal, "moderator");
  const applicant = await api.actor(org);
  const request = await prisma.spaceJoinRequest.create({
    data: { spaceId: space.id, userId: applicant.principal.id },
  });
  return { org, moderator, space, applicant, request };
};

describe("POST /v1/spaces/:spaceId/join-requests/:principalId/approve", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("approves the request, adds the member and records both events", async () => {
    const { org, moderator, space, applicant, request } = await setup();

    const res = await approve(
      moderator.token,
      space.id,
      applicant.principal.id
    );

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      id: request.id,
      status: "approved",
      decidedBy: moderator.principal.id,
    });
    expect(res.body.request.decidedAt).not.toBeNull();
    const member = await prisma.spaceMember.findUnique({
      where: {
        spaceId_userId: { spaceId: space.id, userId: applicant.principal.id },
      },
    });
    expect(member?.role).toBe("member");
    const events = await prisma.event.findMany({
      where: { organizationId: org },
      orderBy: { id: "asc" },
    });
    expect(events.map((e) => e.type)).toEqual([
      "space.member_added",
      "space.join_decided",
    ]);
    expect(events[1].payload).toEqual({ request: res.body.request });
    expect(
      EVENT_TYPES["space.join_decided"].payload.safeParse(events[1].payload)
        .success
    ).toBe(true);
  });

  it("answers 409 conflict to a request that is already decided", async () => {
    const { moderator, space, applicant } = await setup();
    await approve(moderator.token, space.id, applicant.principal.id);

    const again = await approve(
      moderator.token,
      space.id,
      applicant.principal.id
    );

    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
  });

  it("answers 404 when the principal has no request", async () => {
    const { org, moderator, space } = await setup();
    const other = await api.actor(org);

    expect(
      (await approve(moderator.token, space.id, other.principal.id)).status
    ).toBe(404);
  });

  it("answers 403 to a member who cannot moderate, 404 to one who cannot read, 400 to a bad id", async () => {
    const { org, space, applicant } = await setup();
    const member = await api.actor(org);
    await fixtures.member(space, member.principal, "member");
    const hidden = await fixtures.space({ org });
    const outsider = await api.actor(org);

    expect(
      (await approve(member.token, space.id, applicant.principal.id)).status
    ).toBe(403);
    expect(
      (await approve(outsider.token, hidden.id, applicant.principal.id)).status
    ).toBe(404);
    expect((await approve(member.token, space.id, "nope")).status).toBe(400);
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, userId: applicant.principal.id },
      })
    ).toBe(0);
  });

  it("does not add a second membership when the applicant already joined", async () => {
    const { org, moderator, space, applicant } = await setup();
    await fixtures.member(space, applicant.principal, "moderator");

    const res = await approve(
      moderator.token,
      space.id,
      applicant.principal.id
    );

    expect(res.status).toBe(200);
    expect(
      (
        await prisma.spaceMember.findUniqueOrThrow({
          where: {
            spaceId_userId: {
              spaceId: space.id,
              userId: applicant.principal.id,
            },
          },
        })
      ).role
    ).toBe("moderator");
    const types = (
      await prisma.event.findMany({ where: { organizationId: org } })
    ).map((e) => e.type);
    expect(types).toEqual(["space.join_decided"]);
  });
});
