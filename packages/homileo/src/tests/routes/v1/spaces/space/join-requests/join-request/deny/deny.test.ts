// @module-tag int
// @module-tag spaces
import { prisma } from "../../../../../../../../utils/db/prisma.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchJson } from "../../../../../../../support/http.js";
import {
  spaceApiFixtures,
  startV1App,
} from "../../../../../../../support/spaceApi.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const deny = (token: string, spaceId: string, who: string) =>
  fetchJson(
    "POST",
    `${url}/v1/spaces/${spaceId}/join-requests/${who}/deny`,
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
  await prisma.spaceJoinRequest.create({
    data: { spaceId: space.id, userId: applicant.principal.id },
  });
  return { org, moderator, space, applicant };
};

describe("POST /v1/spaces/:spaceId/join-requests/:principalId/deny", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("denies the request, adds no member and records join_decided with an audit UPDATE", async () => {
    const { org, moderator, space, applicant } = await setup();

    const res = await deny(moderator.token, space.id, applicant.principal.id);

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: "denied",
      decidedBy: moderator.principal.id,
    });
    expect(
      await prisma.spaceMember.count({
        where: { spaceId: space.id, userId: applicant.principal.id },
      })
    ).toBe(0);
    const events = await prisma.event.findMany({
      where: { organizationId: org },
    });
    expect(events.map((e) => e.type)).toEqual(["space.join_decided"]);
    const audit = await prisma.$queryRaw<
      Array<{ payload: Record<string, unknown> }>
    >`
      SELECT payload FROM "core"."core_outbox"
      WHERE payload->>'organizationId' = ${org} AND destination = 'audit'`;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({
      action: "UPDATE",
      entityType: "space",
      entityId: space.id,
      userId: moderator.principal.tereoUserId,
    });
  });

  it("answers 409 conflict to a request already decided, and lets the applicant ask again", async () => {
    const { moderator, space, applicant } = await setup();
    await deny(moderator.token, space.id, applicant.principal.id);

    const again = await deny(moderator.token, space.id, applicant.principal.id);
    const rejoin = await fetchJson(
      "POST",
      `${url}/v1/spaces/${space.id}/join`,
      applicant.token
    );

    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
    expect(rejoin.status).toBe(202);
  });

  it("answers 403 to a member who cannot moderate and 404 for a principal without a request", async () => {
    const { org, moderator, space, applicant } = await setup();
    const member = await api.actor(org);
    await fixtures.member(space, member.principal, "member");

    expect(
      (await deny(member.token, space.id, applicant.principal.id)).status
    ).toBe(403);
    expect(
      (await deny(moderator.token, space.id, member.principal.id)).status
    ).toBe(404);
  });
});
