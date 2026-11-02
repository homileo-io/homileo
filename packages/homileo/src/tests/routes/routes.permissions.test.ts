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
 * - every route answers 403 to a token without `homileo.spaces.read` (none, or
 *   only permissions off the ladder), before validation or any lookup runs, and
 *   lets `homileo.spaces.read`, `homileo.spaces.write` or `homileo.chat.admin`
 *   through, except the routes in `READ_EXEMPT`, which act only on the caller's own
 *   membership or participation: a token without it may leave and mute itself there,
 *   by its id in either case, and is still refused acting on anyone else;
 * - every route that changes shared chat state (`WRITE_GATED`) answers 403 to a
 *   token with only `homileo.spaces.read`, and lets `homileo.spaces.write` or
 *   `homileo.chat.admin` through; every other route that is not a GET is listed
 *   in `OPEN_TO_READERS`, so a new mutation must be classified;
 * - the removal routes in `SELF_REMOVAL` refuse a read-only token removing
 *   someone else but let it remove itself, by its id in either case.
 *
 * What it does not prove: which resources a caller may read or change. That is
 * the policy's, tested in `src/tests/policy` and in each route's own
 * `.permissions` file.
 */
import { collectRoutes, type RouteEntry } from "../support/routeTable.js";
import { purgeOrganizations } from "../support/signedIn.js";
import { afterAll, describe, expect, it } from "vitest";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "../support/http.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../env.js";

const PARAM = "00000000-0000-7000-8000-000000000000";

const routes = await collectRoutes();

const v1Routes = routes
  .filter(({ path }) => path.startsWith("/v1/"))
  .map((route) => [route.method.toUpperCase(), route.path, route] as const);

const request = async (
  route: RouteEntry,
  token: string | null,
  principalId = PARAM
) => {
  const url =
    env.PUBLIC_URL +
    route.path.replace(":principalId", principalId).replace(/[:*]\w+/g, PARAM);
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
  { method: "post", path: "/v1/principals/resolve" },
];

/** Routes other than GETs that a read-only token may call: they change only the caller's own state, or nothing. */
const OPEN_TO_READERS: readonly RouteEntry[] = [
  { method: "put", path: "/v1/sessions/:sessionId/read" },
  { method: "put", path: "/v1/sessions/:sessionId/notify" },
  { method: "put", path: "/v1/threads/:rootId/read" },
  { method: "put", path: "/v1/threads/:rootId/follow" },
];

/** Write-gated for removing someone else, open to readers when `:principalId` is the caller (leaving). */
const SELF_REMOVAL: readonly RouteEntry[] = [
  { method: "delete", path: "/v1/spaces/:spaceId/members/:principalId" },
  {
    method: "delete",
    path: "/v1/sessions/:sessionId/participants/:principalId",
  },
];

/**
 * `/v1` routes a token without `homileo.spaces.read` may call on its own membership or
 * participation (`requireChatReadUnlessSelf`), so a revoked reader can still leave and mute.
 * `target: "param"` names the principal in `:principalId`, which must be the caller;
 * `target: "caller"` always acts on the caller.
 */
const READ_EXEMPT: readonly (RouteEntry & { target: "param" | "caller" })[] = [
  {
    method: "delete",
    path: "/v1/spaces/:spaceId/members/:principalId",
    target: "param",
  },
  {
    method: "delete",
    path: "/v1/sessions/:sessionId/participants/:principalId",
    target: "param",
  },
  { method: "put", path: "/v1/sessions/:sessionId/notify", target: "caller" },
];

const key = (r: RouteEntry) => `${r.method} ${r.path}`;

// A `param` route stays here: with someone else's id (`PARAM`) it is read-gated.
const readGated = v1Routes.filter(
  ([, , route]) =>
    !READ_EXEMPT.filter((r) => r.target === "caller")
      .map(key)
      .includes(key(route))
);

/** A token without permissions and its principal's id, which `/v1/me` would refuse to say. */
const unreadableCaller = async () => {
  const userId = uuidv7();
  const token = personToken({ userId, org: ORG, perms: [] });
  await fetch(`${env.PUBLIC_URL}/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const principal = await prisma.principal.findUniqueOrThrow({
    where: { tereoUserId: userId },
  });
  return { token, principalId: principal.id };
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

describe.each(readGated)("read-gated %s %s", (_method, _path, route) => {
  it.each([[[]], [["homileo.messages.read_private"]]])(
    "returns 403 forbidden for a token with %j",
    async (perms: string[]) => {
      const token = personToken({ org: ORG, perms });

      const { status, body } = await request(route, token);

      expect(status, body).toBe(403);
      expect(JSON.parse(body)).toMatchObject({
        error: "forbidden",
        error_description: "Requires the homileo.spaces.read permission",
      });
    }
  );

  it.each([
    ["homileo.spaces.read"],
    ["homileo.spaces.write"],
    ["homileo.chat.admin"],
  ])("passes the read gate with %s", async (permission) => {
    const token = personToken({ org: ORG, perms: [permission] });

    const { body } = await request(route, token);

    expect(body).not.toContain("Requires the homileo.spaces.read permission");
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

describe.each(SELF_REMOVAL)("self-removal $method $path", (route) => {
  it("is write-gated for someone else", () => {
    expect(WRITE_GATED).toContainEqual(route);
  });

  it("does not refuse a token with only homileo.spaces.read removing itself", async () => {
    const token = personToken({ org: ORG, perms: READ_ONLY });
    const me = await fetchJson("GET", `${env.PUBLIC_URL}/v1/me`, token);

    const { status, body } = await request(route, token, me.body.principal.id);

    expect(status, body).not.toBe(403);
  });

  it("does not refuse a token with only homileo.spaces.read removing itself by its upper-case id", async () => {
    const token = personToken({ org: ORG, perms: READ_ONLY });
    const me = await fetchJson("GET", `${env.PUBLIC_URL}/v1/me`, token);

    const { status, body } = await request(
      route,
      token,
      String(me.body.principal.id).toUpperCase()
    );

    expect(status, body).not.toBe(403);
  });
});

describe.each(OPEN_TO_READERS)("open to readers $method $path", (route) => {
  it("does not refuse a token with only homileo.spaces.read", async () => {
    const token = personToken({ org: ORG, perms: READ_ONLY });

    const { status, body } = await request(route, token);

    expect(status, body).not.toBe(403);
  });
});

describe.each(READ_EXEMPT)("read-exempt $method $path", (route) => {
  it("is listed among the routes", () => {
    expect(v1Routes.map(([, , r]) => key(r))).toContain(key(route));
  });

  it("does not refuse a token without permissions acting on itself", async () => {
    const { token, principalId } = await unreadableCaller();

    const { body } = await request(route, token, principalId);

    expect(body).not.toContain("Requires the homileo.spaces.read permission");
  });

  it("does not refuse a token without permissions acting on itself by its upper-case id", async () => {
    const { token, principalId } = await unreadableCaller();

    const { body } = await request(route, token, principalId.toUpperCase());

    expect(body).not.toContain("Requires the homileo.spaces.read permission");
  });

  it.runIf(route.target === "param")(
    "returns 403 forbidden for a token without permissions acting on someone else",
    async () => {
      const { token } = await unreadableCaller();
      const other = await unreadableCaller();

      const { status, body } = await request(route, token, other.principalId);

      expect(status, body).toBe(403);
      expect(JSON.parse(body)).toMatchObject({
        error: "forbidden",
        error_description: "Requires the homileo.spaces.read permission",
      });
    }
  );
});

describe("read gate exemption", () => {
  const call = async (method: string, path: string, token: string) => {
    const response = await fetch(`${env.PUBLIC_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" ? undefined : "{}",
    });
    return { status: response.status, body: await response.text() };
  };

  it.each([
    ["GET", "/v1/sessions/:id/participants/:self"],
    ["PUT", "/v1/sessions/:id/participants/:self"],
    ["DELETE", "/v1/sessions/:id/participants/:self/x"],
    ["DELETE", "/v1/sessions/:id/participants"],
    ["GET", "/v1/sessions/:id/notify"],
    ["DELETE", "/v1/sessions/:id/notify"],
    ["GET", "/v1/spaces/:id/members/:self"],
    ["PUT", "/v1/spaces/:id/members/:self"],
    ["DELETE", "/v1/spaces/:id/members/:self/x"],
    ["DELETE", "/v1/spaces/:id/members"],
    ["DELETE", "/v1//spaces/:id/members/:self"],
    ["DELETE", "/v1/spaces/:id//members/:self"],
    ["DELETE", "/v1/spaces/:id/members//:self"],
    ["DELETE", "/v1/spaces/:id/members/:self//"],
    ["DELETE", "/v1/sessions/:id//participants/:self"],
    ["PUT", "/v1/sessions/:id//notify"],
    ["PUT", "/v1/sessions//:id/notify"],
    ["DELETE", "/v1/spaces/:id/members%2F:self"],
    ["DELETE", "/v1/spaces/:id%2Fmembers%2F:self"],
    ["DELETE", "/v1/sessions/:id/participants%2F:self"],
    ["PUT", "/v1/sessions/:id%2Fnotify"],
  ])(
    "still refuses a token without permissions on %s %s",
    async (method, path) => {
      const { token, principalId } = await unreadableCaller();

      const { status, body } = await call(
        method,
        path.replace(":id", PARAM).replace(":self", principalId),
        token
      );

      expect(status, body).toBe(403);
      expect(JSON.parse(body).error_description).toBe(
        "Requires the homileo.spaces.read permission"
      );
    }
  );

  it.each([
    ["DELETE", "/V1/SPACES/:id/MEMBERS/:self"],
    ["DELETE", "/v1/Sessions/:id/Participants/:self"],
    ["PUT", "/v1/SESSIONS/:id/NOTIFY"],
  ])(
    "treats the upper-case path %s %s as the route, refusing with a plain 404",
    async (method, path) => {
      const { token, principalId } = await unreadableCaller();

      const { status, body } = await call(
        method,
        path.replace(":id", PARAM).replace(":self", principalId),
        token
      );

      expect(status, body).toBe(404);
      expect(JSON.parse(body)).toEqual({
        error: "not_found",
        error_description: "Not found",
      });
    }
  );
});
