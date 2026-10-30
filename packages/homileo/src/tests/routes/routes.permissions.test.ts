// @module-tag int
// @module-tag auth
// @module-tag security
/**
 * Generated auth enforcement over every route under `/v1` (`collectRoutes`).
 *
 * What it proves:
 * - every route answers 401 to a request without a token;
 * - every route answers 400 `organization_required` to a token without an
 *   organization, before validation or any lookup runs.
 *
 * What it does not prove: which resources a caller may read or change. That is
 * the policy's, tested in `src/tests/policy` and in each route's own
 * `.permissions` file.
 */
import { collectRoutes, type RouteEntry } from "../support/routeTable.js";
import { personToken } from "../support/tokens.js";
import { describe, expect, it } from "vitest";
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

describe("route table", () => {
  it("finds the routes under /v1", () => {
    expect(routes).toEqual(
      expect.arrayContaining([
        { method: "get", path: "/v1/me" },
        { method: "get", path: "/health" },
      ])
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
