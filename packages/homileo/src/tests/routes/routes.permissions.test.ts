// @module-tag int
// @module-tag auth
// @module-tag security
/**
 * Generated auth enforcement over every route under `/v1` (`collectRoutes`).
 *
 * What it proves:
 * - every route answers 401 to a request without a token;
 * - every route answers 400 `organization_required` to a token without an
 *   organization, before validation or any lookup runs;
 * - every route that changes shared chat state (`WRITE_GATED`) answers 403 to a
 *   token with only `homileo.spaces.read`, and lets `homileo.spaces.write` or
 *   `homileo.chat.admin` through; every other route that is not a GET is listed
 *   in `OPEN_TO_READERS`, so a new mutation must be classified.
 *
 * What it does not prove: which resources a caller may read or change. That is
 * the policy's, tested in `src/tests/policy` and in each route's own
 * `.permissions` file.
 */
import { collectRoutes, type RouteEntry } from "../support/routeTable.js";
import { purgeOrganizations } from "../support/signedIn.js";
import { afterAll, describe, expect, it } from "vitest";
import { personToken } from "../support/tokens.js";
import env from "../../env.js";

const PARAM = "00000000-0000-7000-8000-000000000000";

const routes = await collectRoutes();

const v1Routes = routes
  .filter(({ path }) => path.startsWith("/v1/"))
  .map((route) => [route.method.toUpperCase(), route.path, route] as const);

const request = async (route: RouteEntry, token: string | null) => {
  const url = env.PUBLIC_URL + route.path.replace(/[:*]\w+/g, PARAM);
  const hasBody = route.method !== "get" && route.method !== "head";
  const response = await fetch(url, {
    method: route.method.toUpperCase(),
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(hasBody && { "Content-Type": "application/json" }),
    },
    body: hasBody ? "{}" : undefined,
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
};

const ORG = "0198c3a4-5b6d-7a10-8f2e-3c4d5e6f7a8b";
const READ_ONLY = ["homileo.spaces.read"];

// A write token's `{}` can create a session here.
afterAll(() => purgeOrganizations([ORG]));

/** Every `/v1` route that changes shared chat state (`requireChatWrite`). */
const WRITE_GATED: readonly RouteEntry[] = [
  { method: "post", path: "/v1/spaces" },
  { method: "patch", path: "/v1/spaces/:spaceId" },
  { method: "post", path: "/v1/spaces/:spaceId/archive" },
  { method: "post", path: "/v1/spaces/:spaceId/join" },
  { method: "put", path: "/v1/spaces/:spaceId/members/:principalId" },
  { method: "delete", path: "/v1/spaces/:spaceId/members/:principalId" },
  {
    method: "post",
    path: "/v1/spaces/:spaceId/join-requests/:principalId/approve",
  },
  {
    method: "post",
    path: "/v1/spaces/:spaceId/join-requests/:principalId/deny",
  },
  { method: "post", path: "/v1/sessions" },
  { method: "post", path: "/v1/sessions/direct" },
  { method: "patch", path: "/v1/sessions/:sessionId" },
  { method: "post", path: "/v1/sessions/:sessionId/archive" },
  { method: "post", path: "/v1/sessions/:sessionId/attachments" },
  { method: "post", path: "/v1/sessions/:sessionId/messages" },
  { method: "put", path: "/v1/sessions/:sessionId/participants/:principalId" },
  {
    method: "delete",
    path: "/v1/sessions/:sessionId/participants/:principalId",
  },
  { method: "patch", path: "/v1/messages/:messageId" },
  { method: "delete", path: "/v1/messages/:messageId" },
  { method: "put", path: "/v1/messages/:messageId/reactions/:emoji" },
  { method: "delete", path: "/v1/messages/:messageId/reactions/:emoji" },
];

/** Routes other than GETs that a read-only token may call: they change only the caller's own state, or nothing. */
const OPEN_TO_READERS: readonly RouteEntry[] = [
  { method: "post", path: "/v1/principals/resolve" },
  { method: "put", path: "/v1/sessions/:sessionId/read" },
  { method: "put", path: "/v1/sessions/:sessionId/notify" },
  { method: "put", path: "/v1/threads/:rootId/read" },
  { method: "put", path: "/v1/threads/:rootId/follow" },
];

const key = (r: RouteEntry) => `${r.method} ${r.path}`;

describe("route table", () => {
  it("finds the routes under /v1", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: "get", path: "/v1/me" },
        { method: "get", path: "/health" },
      ])
    );
  });

  it("classifies every /v1 route that is not a GET as write-gated or open to readers", () => {
    const mutations = routes
      .filter((r) => r.path.startsWith("/v1/"))
      .filter((r) => r.method !== "get" && r.method !== "head")
      .map(key)
      .sort();

    expect(mutations).toEqual(
      [...WRITE_GATED, ...OPEN_TO_READERS].map(key).sort()
    );
  });
});

describe.each(v1Routes)("%s %s", (_method, _path, route) => {
  it("returns 401 without a token", async () => {
    const { status, body } = await request(route, null);

    expect(status, body).toBe(401);
  });

  it("returns 400 organization_required for a token without an organization", async () => {
    const { status, body } = await request(route, personToken({ org: null }));

    expect(status, body).toBe(400);
    expect(JSON.parse(body).error).toBe("organization_required");
  });
});

describe.each(WRITE_GATED)("write-gated $method $path", (route) => {
  it("returns 403 forbidden for a token with only homileo.spaces.read", async () => {
    const token = personToken({ org: ORG, perms: READ_ONLY });

    const { status, body } = await request(route, token);

    expect(status, body).toBe(403);
    expect(JSON.parse(body)).toMatchObject({
      error: "forbidden",
      error_description: "Requires the homileo.spaces.write permission",
    });
  });

  it("returns 403 forbidden for a token without permissions", async () => {
    const { status } = await request(
      route,
      personToken({ org: ORG, perms: [] })
    );

    expect(status).toBe(403);
  });

  it.each([["homileo.spaces.write"], ["homileo.chat.admin"]])(
    "lets a token with %s through",
    async (permission) => {
      const token = personToken({ org: ORG, perms: [permission] });

      const { status, body } = await request(route, token);

      expect(status, body).not.toBe(403);
    }
  );
});

describe.each(OPEN_TO_READERS)("open to readers $method $path", (route) => {
  it("does not refuse a token with only homileo.spaces.read", async () => {
    const token = personToken({ org: ORG, perms: READ_ONLY });

    const { status, body } = await request(route, token);

    expect(status, body).not.toBe(403);
  });
});
