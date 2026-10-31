// @module-tag int
// @module-tag platform
import { MS_PER_DAY, partitionName, utcDay } from "../utils/partitions.js";
import { getTereo, initializeTereo } from "../utils/tereo.js";
import { describe, expect, it, vi } from "vitest";
import * as eventsDb from "../utils/db/events.js";
import { prisma } from "../utils/db/prisma.js";
import { createAppServer } from "../index.js";
import { fetchJson } from "./support/http.js";
import { redis } from "../utils/redis.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

// The shared server listens on PORT; the two servers here take the next two.
const basePort = Number(process.env.PORT);
const apiPort = basePort + 1;
const stopPort = basePort + 2;
const failPort = basePort + 3;

describe("ROLE=api", () => {
  // A process of its own: the role is read from the environment when the
  // modules load, and the shared server runs every role.
  it("serves /health and runs no worker", async () => {
    const port = apiPort;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(packageRoot, "src/index.ts")],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          ROLE: "api",
          PORT: String(port),
          PUBLIC_URL: `http://localhost:${port}`,
          LOG_LEVEL: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code))
    );

    try {
      await expect
        .poll(() => output, { timeout: 20_000, interval: 100 })
        .toContain("homileo listening");
      const res = await fetchJson(
        "GET",
        `http://localhost:${port}/health`,
        null
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", postgres: "ok", redis: "ok" });
      expect(output).not.toContain("homileo worker started");
      // The tereo client starts in every role, the api included.
      expect(output).toContain("Started request handler");
    } finally {
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  });
});

describe("start", () => {
  // Before the "stop" tests: a failed start leaves Redis and tereo up, which
  // they start again themselves, and stopping would close the pool they use.
  it("fails when today's partition cannot be created", async () => {
    const today = utcDay();
    const name = partitionName(today);
    const day = (d: Date) => d.toISOString().split("T")[0];
    await eventsDb.createPartition(
      name,
      day(today),
      day(new Date(today.getTime() + MS_PER_DAY))
    );
    // Gone from the table as far as pg_inherits knows, and the create stubbed
    // to give up as it does when the lock is not granted in time.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "chat"."events" DETACH PARTITION "chat"."${name}"`
    );
    const create = vi
      .spyOn(eventsDb, "createPartition")
      .mockResolvedValue(false);
    try {
      await expect(createAppServer(failPort).start()).rejects.toThrow(
        /partition/i
      );
    } finally {
      create.mockRestore();
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "chat"."events" ATTACH PARTITION "chat"."${name}" FOR VALUES FROM ('${day(today)}') TO ('${day(new Date(today.getTime() + MS_PER_DAY))}')`
      );
    }
  });
});

describe("stop", () => {
  it("starts and stops the tereo client once, and drains and closes Postgres and Redis", async () => {
    // Created here so the spies are in place before start() runs;
    // start() then finds the client and uses it.
    await initializeTereo();
    const tereoStart = vi.spyOn(getTereo(), "start");
    const tereoStop = vi.spyOn(getTereo(), "stop");
    const server = createAppServer(stopPort);
    await server.start();
    expect(tereoStart).toHaveBeenCalledTimes(1);
    expect(
      (await fetchJson("GET", `http://localhost:${stopPort}/health`, null))
        .status
    ).toBe(200);

    await server.stop();

    expect(tereoStop).toHaveBeenCalledTimes(1);
    expect(server.isRunning()).toBe(false);
    await expect(
      fetch(`http://localhost:${stopPort}/health`, {
        signal: AbortSignal.timeout(2000),
      })
    ).rejects.toThrow();
    expect(redis.status).toBe("end");
    await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow();
  });
});
