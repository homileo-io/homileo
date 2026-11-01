// @module-tag int
// @module-tag auth
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppError, UnauthorizedError } from "../../utils/errors.js";
import { setProfileLookup } from "../../utils/db/principals.js";
import { initializeTereo } from "../../utils/tereo.js";
import type { AuthServiceUser } from "@tereo-io/sdk";
import { errorHandler } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "../support/http.js";
import { v7 as uuidv7 } from "uuid";
import type { Server } from "http";
import express from "express";
import {
  authenticate,
  callerFromToken,
  callerOf,
} from "../../middleware/auth.js";

const serve = async (
  app: express.Express
): Promise<{ url: string; server: Server }> => {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return { url: `http://localhost:${port}`, server };
};

describe("auth middleware", () => {
  let server: Server | null = null;
  beforeAll(async () => {
    await initializeTereo();
  });
  afterEach(() => {
    setProfileLookup(null);
    server?.close();
    server = null;
  });

  it("authenticate answers 400 organization_required without an organization", async () => {
    const app = express();
    app.get("/x", authenticate, (_req, res) => {
      res.json({});
    });
    app.use(errorHandler);
    const started = await serve(app);
    server = started.server;

    const res = await fetchJson(
      "GET",
      `${started.url}/x`,
      `test-token-${uuidv7()}`
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("organization_required");
  });

  it("authenticate sets a caller with the token's organization", async () => {
    const org = uuidv7();
    const app = express();
    app.get("/x", authenticate, (req, res) => {
      res.json({ org: callerOf(req).organizationId });
    });
    app.use(errorHandler);
    const started = await serve(app);
    server = started.server;

    const res = await fetchJson(
      "GET",
      `${started.url}/x`,
      `test-token-${uuidv7()}|org=${org}`
    );

    expect(res.body).toEqual({ org });
  });
});

describe("principal loading", () => {
  let server: Server | null = null;
  let url = "";
  const org = uuidv7();
  beforeAll(async () => {
    await initializeTereo();
  });
  afterEach(() => {
    setProfileLookup(null);
    server?.close();
    server = null;
  });

  const start = async () => {
    const app = express();
    app.get("/x", authenticate, (req, res) => {
      res.json({ principalId: callerOf(req).principalId });
    });
    app.use(errorHandler);
    const started = await serve(app);
    server = started.server;
    url = `${started.url}/x`;
  };

  /** The row with its tuple version: `xmin` changes on any write, even a no-op one. */
  const row = async (tereoUserId: string) => {
    const [r] = await prisma.$queryRaw<
      Array<{
        xmin: string;
        updated_at: Date;
        display_name: string | null;
        profile_refreshed_at: Date | null;
      }>
    >`SELECT xmin::text, updated_at, display_name, profile_refreshed_at
      FROM "chat"."principals" WHERE tereo_user_id = ${tereoUserId}::uuid`;
    return r;
  };

  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("condition not met in time");
  };

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("writes nothing on a second request for an existing principal", async () => {
    await start();
    const userId = uuidv7();
    await fetchJson("GET", url, `test-token-${userId}|org=${org}`);
    await waitFor(async () => (await row(userId))?.display_name != null);
    const before = await row(userId);

    const res = await fetchJson("GET", url, `test-token-${userId}|org=${org}`);
    await pause(200);

    expect(res.status).toBe(200);
    expect(await row(userId)).toEqual(before);
  });

  it("answers despite a failing profile lookup, and stamps the attempt", async () => {
    let calls = 0;
    setProfileLookup(async () => {
      calls++;
      throw new Error("tereo down");
    });
    await start();
    const userId = uuidv7();

    const first = await fetchJson(
      "GET",
      url,
      `test-token-${userId}|org=${org}`
    );
    await waitFor(
      async () => (await row(userId))?.profile_refreshed_at != null
    );
    const second = await fetchJson(
      "GET",
      url,
      `test-token-${userId}|org=${org}`
    );
    await pause(200);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await row(userId)).display_name).toBeNull();
    expect(calls).toBe(1);
  });

  it("refreshes a stale profile once for concurrent requests", async () => {
    let calls = 0;
    setProfileLookup(async (id) => {
      calls++;
      await pause(100);
      return { id, name: "Ada" } as AuthServiceUser;
    });
    await start();
    const userId = uuidv7();
    await prisma.principal.create({
      data: { kind: "user", tereoUserId: userId },
    });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        fetchJson("GET", url, `test-token-${userId}|org=${org}`)
      )
    );
    await waitFor(async () => (await row(userId))?.display_name === "Ada");
    await pause(100);

    expect(calls).toBe(1);
  });
});

describe("callerFromToken", () => {
  beforeAll(async () => {
    await initializeTereo();
  });

  const refusal = (token: string) =>
    callerFromToken(token).then(
      () => {
        throw new Error("expected a refusal");
      },
      (err: AppError) => err
    );

  it("returns the caller, principal and exp of a token with an organization", async () => {
    const org = uuidv7();
    const userId = uuidv7();

    const { caller, principal, exp } = await callerFromToken(
      `test-token-${userId}|org=${org}|perms=homileo.chat.admin`
    );

    expect(principal.tereoUserId).toBe(userId);
    expect(caller).toEqual({
      principalId: principal.id,
      tereoUserId: userId,
      isBot: false,
      permissions: ["homileo.chat.admin"],
      isAdmin: true,
      organizationId: org,
    });
    expect(exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("makes a service account's principal a bot", async () => {
    const id = uuidv7();

    const { caller } = await callerFromToken(
      `test-token-${id}|client=${id}|org=${uuidv7()}`
    );

    expect(caller.isBot).toBe(true);
  });

  it("refuses an inactive token as unauthorized", async () => {
    const err = await refusal("not-a-token");

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.code).toBe("unauthorized");
  });

  it("refuses a token without an organization before creating a principal", async () => {
    const userId = uuidv7();

    const err = await refusal(`test-token-${userId}`);

    expect(err.code).toBe("organization_required");
    expect(
      await prisma.principal.findFirst({ where: { tereoUserId: userId } })
    ).toBeNull();
  });
});
