// @module-tag int
// @module-tag auth
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import principalsRouter from "../../../../../routes/v1/principals/index.js";
import { setUsersLookup } from "../../../../../utils/db/principals.js";
import { botToken, personToken } from "../../../../support/tokens.js";
import { authenticate } from "../../../../../middleware/auth.js";
import { initializeTereo } from "../../../../../utils/tereo.js";
import { errorHandler } from "../../../../../utils/errors.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import type { AuthServiceUser } from "@tereo-io/sdk";
import { v7 as uuidv7 } from "uuid";
import type { Server } from "http";
import express from "express";

const user = (
  id: string,
  over: Partial<AuthServiceUser> = {}
): AuthServiceUser =>
  ({
    id,
    name: `User ${id.slice(-6)}`,
    userType: "person",
    ...over,
  }) as AuthServiceUser;

// The lookup stub lives in this process, so the router is mounted on an app
// served from it rather than reached through the shared server.
describe("POST /v1/principals/resolve", () => {
  let server: Server;
  let url: string;
  const created: string[] = [];
  const token = () => personToken({ org: uuidv7() });
  const resolve = (ids: string[], t: string | null = token()) =>
    fetchJson("POST", `${url}/v1/principals/resolve`, t, {
      tereoUserIds: ids,
    });
  const ids = (n: number) => {
    const out = Array.from({ length: n }, () => uuidv7());
    created.push(...out);
    return out;
  };

  beforeAll(async () => {
    await initializeTereo();
    const app = express();
    app.use(express.json());
    app.use("/v1/principals", authenticate, principalsRouter);
    app.use(errorHandler);
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    url = `http://localhost:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => {
    setUsersLookup(null);
  });
  afterAll(async () => {
    server.close();
    await prisma.principal.deleteMany({
      where: { tereoUserId: { in: created } },
    });
  });

  it("creates principals for unseen tereo users and returns existing ones unchanged", async () => {
    const [known, fresh] = ids(2);
    const existing = await prisma.principal.create({
      data: { kind: "user", tereoUserId: known, displayName: "Kept Name" },
    });
    let asked: string[] = [];
    setUsersLookup(async (wanted) => {
      asked = wanted;
      return new Map(wanted.map((id) => [id, user(id, { name: "Fresh One" })]));
    });

    const res = await resolve([fresh, known]);

    expect(res.status).toBe(200);
    expect(res.body.missing).toEqual([]);
    expect(
      res.body.data.map((p: { tereoUserId: string }) => p.tereoUserId)
    ).toEqual([fresh, known]);
    expect(res.body.data[0]).toMatchObject({
      kind: "user",
      isBot: false,
      displayName: "Fresh One",
    });
    expect(res.body.data[1]).toMatchObject({
      id: existing.id,
      displayName: "Kept Name",
    });
    expect(asked).toEqual([fresh]);
  });

  it("lists ids tereo does not know in missing", async () => {
    const [known, unknown] = ids(2);
    setUsersLookup(
      async (wanted) =>
        new Map(wanted.map((id) => [id, id === known ? user(id) : null]))
    );

    const res = await resolve([unknown, known]);

    expect(res.status).toBe(200);
    expect(res.body.missing).toEqual([unknown]);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].tereoUserId).toBe(known);
    expect(
      await prisma.principal.count({ where: { tereoUserId: unknown } })
    ).toBe(0);
  });

  it("marks service accounts as bots", async () => {
    const [bot] = ids(1);
    setUsersLookup(
      async (wanted) =>
        new Map(
          wanted.map((id) => [id, user(id, { userType: "service_account" })])
        )
    );

    const res = await resolve([bot], botToken({ org: uuidv7() }));

    expect(res.status).toBe(200);
    expect(res.body.data[0].isBot).toBe(true);
  });

  it("truncates a display name past 255 characters", async () => {
    const [long] = ids(1);
    setUsersLookup(
      async (wanted) =>
        new Map(wanted.map((id) => [id, user(id, { name: "x".repeat(300) })]))
    );

    const res = await resolve([long]);

    expect(res.body.data[0].displayName).toHaveLength(255);
  });

  it("answers 400 invalid_request for an empty list", async () => {
    const res = await resolve([]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("answers 401 without a token", async () => {
    const res = await resolve(ids(1), null);

    expect(res.status).toBe(401);
  });

  it(
    "is safe to call concurrently for the same ids",
    { tags: ["race"] },
    async () => {
      const wanted = ids(4);
      setUsersLookup(
        async (asked) => new Map(asked.map((id) => [id, user(id)]))
      );

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => resolve(wanted))
      );

      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(
        new Set(
          responses.map((r) =>
            r.body.data.map((p: { id: string }) => p.id).join()
          )
        ).size
      ).toBe(1);
      expect(
        await prisma.principal.count({ where: { tereoUserId: { in: wanted } } })
      ).toBe(4);
    }
  );
});
