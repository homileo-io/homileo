// @module-tag int
// @module-tag platform
import { describe, expect, it, vi } from "vitest";
import { prisma } from "../utils/db/prisma.js";
import { createAppServer } from "../index.js";
import { fetchJson } from "./support/http.js";
import { getTereo } from "../utils/tereo.js";
import { redis } from "../utils/redis.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

describe("ROLE=api", () => {
  // A process of its own: the role is read from the environment when the
  // modules load, and the shared server runs every role.
  it("serves /health and runs no worker", async () => {
    const port = 4152;
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

describe("stop", () => {
  it("drains and closes Postgres and Redis", async () => {
    const server = createAppServer(4151);
    await server.start();
    expect(
      (await fetchJson("GET", "http://localhost:4151/health", null)).status
    ).toBe(200);

    const stopTereoClient = vi.spyOn(getTereo(), "stop");

    await server.stop();

    expect(stopTereoClient).toHaveBeenCalledTimes(1);
    expect(server.isRunning()).toBe(false);
    await expect(
      fetch("http://localhost:4151/health", {
        signal: AbortSignal.timeout(2000),
      })
    ).rejects.toThrow();
    expect(redis.status).toBe("end");
    await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow();
  });
});
