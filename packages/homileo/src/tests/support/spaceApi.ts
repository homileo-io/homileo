import { initializeTereo } from "../../utils/tereo.js";
import { invalidateKinds } from "../../utils/kinds.js";
import { errorHandler } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import { chatFixtures } from "./chatFixtures.js";
import v1Router from "../../routes/v1/index.js";
import { personToken } from "./tokens.js";
import { v7 as uuidv7 } from "uuid";
import type { Server } from "http";
import express from "express";

/**
 * The `/v1` router on an app served from the test's own process. The kind
 * cache and the tereo client then are the test's, so provisioning a kind and
 * `invalidateKinds()` reach the routes, which the shared server's do not.
 */
export const startV1App = async () => {
  await initializeTereo();
  const app = express();
  app.use("/v1", v1Router);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
};

export interface KindOptions {
  grants?: Array<{ permission: string; access: "read" | "moderate" }>;
  overridable?: Array<"visibility" | "join" | "posting">;
  states?: string[];
  bots?: string[];
  defaults?: { visibility: string; join: string; posting: string };
  retired?: boolean;
}

/** Tracks what a test file makes through the API and removes it afterwards. */
export const spaceApiFixtures = () => {
  const fixtures = chatFixtures();
  const organizations: string[] = [];
  const kinds: string[] = [];
  const tereoUsers: string[] = [];

  const organization = () => {
    const id = uuidv7();
    organizations.push(id);
    fixtures.organization(id);
    return id;
  };

  /** A person with a principal row (so fixtures can make them a member) and a token. */
  const actor = async (org: string, perms: string[] = []) => {
    const principal = await fixtures.principal();
    return {
      principal,
      token: personToken({ userId: principal.tereoUserId!, org, perms }),
    };
  };

  const kind = async (name: string, o: KindOptions = {}) => {
    kinds.push(name);
    tereoUsers.push(...(o.bots ?? []));
    await prisma.provisionedSpaceKind.create({
      data: {
        name,
        app: "spaces-test",
        definition: {
          name,
          defaults: o.defaults ?? {
            visibility: "members",
            join: "invite",
            posting: "members",
          },
          overridable: o.overridable ?? [],
          states: o.states ?? [],
          grants: o.grants ?? [],
          bots: o.bots ?? [],
          editWindowSeconds: null,
          search: { metadata: [] },
        },
        documentVersion: "1.0.0",
        sourceFile: "spaces.json",
        retiredAt: o.retired ? new Date() : null,
      },
    });
    invalidateKinds();
    return name;
  };

  const cleanup = async () => {
    await prisma.event.deleteMany({
      where: { organizationId: { in: organizations } },
    });
    for (const org of organizations) {
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${org}`;
    }
    await fixtures.cleanup();
    await prisma.principal.deleteMany({
      where: { tereoUserId: { in: tereoUsers } },
    });
    await prisma.provisionedSpaceKind.deleteMany({
      where: { name: { in: kinds } },
    });
    invalidateKinds();
  };

  return { fixtures, organization, actor, kind, cleanup };
};
