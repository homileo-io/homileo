// @module-tag int
// @module-tag auth
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
  requireOrganization,
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

  it("requireOrganization answers 400 organization_required without one", async () => {
    const app = express();
    app.get("/x", authenticate, requireOrganization, (_req, res) => {
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

  it("requireOrganization passes a caller with one", async () => {
    const org = uuidv7();
    const app = express();
    app.get("/x", authenticate, requireOrganization, (req, res) => {
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
