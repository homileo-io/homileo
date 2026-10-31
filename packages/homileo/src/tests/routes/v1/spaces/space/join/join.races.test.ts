// @module-tag int
// @module-tag spaces
// @module-tag race
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spaceApiFixtures } from "../../../../../support/spaceApi.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../../support/v1App.js";
import { fetchJson } from "../../../../../support/http.js";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

describe("POST /v1/spaces/:spaceId/join races", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  it("answers 200 with the same member to two simultaneous joins of an open space, and records one event", async () => {
    const org = api.organization();
    const space = await fixtures.space({
      org,
      joinPolicy: "open",
      visibility: "public",
    });
    const joiner = await api.actor(org);

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        fetchJson("POST", `${url}/v1/spaces/${space.id}/join`, joiner.token)
      )
    );

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body.member).toEqual(results[1].body.member);
    const events = await prisma.event.findMany({
      where: { organizationId: org, type: "space.member_added" },
    });
    expect(events).toHaveLength(1);
  });

  it("answers 200 with the existing member, recording nothing, when the create hits the key after the check missed", async () => {
    const org = api.organization();
    const space = await fixtures.space({
      org,
      joinPolicy: "open",
      visibility: "public",
    });
    const joiner = await api.actor(org);
    const member = await fixtures.member(space, joiner.principal, "member");
    // Inside the transaction the member is not found, as when a simultaneous join commits after the check and before the create.
    const original = prisma.$transaction.bind(prisma) as (
      ...a: unknown[]
    ) => unknown;
    let missed = false;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      fn: unknown,
      ...rest: unknown[]
    ) =>
      typeof fn === "function"
        ? original(
            (tx: Record<string, unknown>) =>
              (fn as (t: unknown) => unknown)(
                new Proxy(tx, {
                  get: (target, key: string) =>
                    key === "spaceMember"
                      ? {
                          ...(target[key] as object),
                          create: (target[key] as { create: unknown }).create,
                          findUnique: async () => {
                            missed = true;
                            return null;
                          },
                        }
                      : target[key],
                })
              ),
            ...rest
          )
        : original(fn, ...rest)) as unknown as typeof prisma.$transaction);

    let res;
    try {
      res = await fetchJson(
        "POST",
        `${url}/v1/spaces/${space.id}/join`,
        joiner.token
      );
    } finally {
      spy.mockRestore();
    }

    expect(missed).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({
      spaceId: space.id,
      principalId: joiner.principal.id,
      role: member.role,
    });
    expect(await prisma.event.count({ where: { organizationId: org } })).toBe(
      0
    );
  });
});
