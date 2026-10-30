import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { invalidateKinds } from "../../utils/kinds.js";
import { errorHandler } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import routes from "../../routes/index.js";
import { v7 as uuidv7 } from "uuid";
import type { Server } from "http";
import express from "express";

/**
 * The real routes on an app of the test's own. The shared server caches kinds
 * in another process, so a test that provisions a kind runs its requests here,
 * where `invalidateKinds` reaches the cache the routes read.
 */
export const startApp = async (): Promise<{
  url: string;
  stop: () => Promise<void>;
}> => {
  await initializeTereo();
  const app = express();
  app.use(express.json());
  app.use(routes);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://localhost:${port}`,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await stopTereo();
    },
  };
};

export interface KindOptions {
  bots?: string[];
  states?: string[];
  grants?: Array<{ permission: string; access: "read" | "moderate" }>;
}

const created: string[] = [];

/** A provisioned space kind of its own; `removeKinds` deletes every one made. */
export const provisionKind = async (o: KindOptions = {}): Promise<string> => {
  const name = `sessions-test:${uuidv7().slice(-12)}`;
  created.push(name);
  await prisma.provisionedSpaceKind.create({
    data: {
      name,
      app: "sessions-test",
      definition: {
        name,
        defaults: { visibility: "members", join: "invite", posting: "members" },
        overridable: [],
        states: o.states ?? [],
        grants: o.grants ?? [],
        bots: o.bots ?? [],
        editWindowSeconds: null,
        search: { metadata: [] },
      },
      documentVersion: "1.0.0",
      sourceFile: "sessions.json",
    },
  });
  invalidateKinds();
  return name;
};

export const removeKinds = async () => {
  await prisma.provisionedSpaceKind.deleteMany({
    where: { name: { in: created } },
  });
  invalidateKinds();
};
