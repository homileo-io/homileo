import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { invalidateKinds } from "../../utils/kinds.js";
import { errorHandler } from "../../utils/errors.js";
import { prisma } from "../../utils/db/prisma.js";
import v1Router from "../../routes/v1/index.js";
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
  return {
    url,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await stopTereo();
    },
  };
};

export interface KindOptions {
  name?: string;
  grants?: Array<{ permission: string; access: "read" | "moderate" }>;
  overridable?: Array<"visibility" | "join" | "posting">;
  states?: string[];
  bots?: string[];
  defaults?: { visibility: string; join: string; posting: string };
  editWindowSeconds?: number | null;
  retired?: boolean;
}

const created: string[] = [];

/** A provisioned space kind of its own; `removeKinds` deletes every one made. */
export const provisionKind = async (o: KindOptions = {}): Promise<string> => {
  const name = o.name ?? `v1-test:${uuidv7().slice(-12)}`;
  created.push(name);
  await prisma.provisionedSpaceKind.create({
    data: {
      name,
      app: "v1-test",
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
        editWindowSeconds: o.editWindowSeconds ?? null,
        search: { metadata: [] },
      },
      documentVersion: "1.0.0",
      sourceFile: "v1-test.json",
      retiredAt: o.retired ? new Date() : null,
    },
  });
  invalidateKinds();
  return name;
};

export const removeKinds = async () => {
  await prisma.provisionedSpaceKind.deleteMany({
    where: { name: { in: created.splice(0) } },
  });
  invalidateKinds();
};
