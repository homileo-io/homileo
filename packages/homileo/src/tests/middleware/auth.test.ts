// @module-tag int
// @module-tag auth
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initializeTereo } from "../../utils/tereo.js";
import { errorHandler } from "../../utils/errors.js";
import { fetchJson } from "../support/http.js";
import { v7 as uuidv7 } from "uuid";
import type { Server } from "http";
import express from "express";
import {
  setOrganizationLookup,
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
    setOrganizationLookup(null);
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

  it("answers 404 for an X-Organization-ID tereo does not know", async () => {
    setOrganizationLookup(async () => null);
    const userId = uuidv7();
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
      `test-token-${userId}|client=${userId}`,
      undefined,
      { "X-Organization-ID": uuidv7() }
    );

    expect(res.status).toBe(404);
  });
});
