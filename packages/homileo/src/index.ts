import "./preload.js";
import { closeHttpServer, tuneServerKeepAlive } from "./utils/httpServer.js";
import { ProvisioningError, provision } from "./utils/provisioning/index.js";
import { closeRedisConnection, initializeRedis } from "./utils/redis.js";
import { getTereo, initializeTereo, stopTereo } from "./utils/tereo.js";
import { disconnectDatabase } from "./utils/db/prisma.js";
import { startWorker, stopWorker } from "./worker.js";
import { createServer, type Server } from "http";
import { logger } from "./utils/logger.js";
import env from "./env.js";
import {
  assertCurrentPartitions,
  ensureEventPartitions,
} from "./utils/partitions.js";
import {
  attachSockets,
  closeSockets,
  disconnectSockets,
} from "./websocket/index.js";

// In-flight HTTP requests get this long before connections are forced closed.
// The rest of the shutdown (Redis, the database) takes a moment more, so the
// default 25s fits the 30s that follow SIGTERM in the chart's pods.
const DRAIN_TIMEOUT_MS = env.SHUTDOWN_TIMEOUT_SECONDS * 1000;

const runsApi = env.ROLE === "all" || env.ROLE === "api";
const runsWorker = env.ROLE === "all" || env.ROLE === "worker";

export interface ServerInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

export function createAppServer(port: number = env.PORT): ServerInstance {
  let server: Server | null = null;
  let running = false;
  let stopping: Promise<void> | null = null;

  return {
    start: async () => {
      if (running) throw new Error("Server is already running");
      running = true;
      await initializeRedis();
      await initializeTereo();
      // The request handler serves every role's calls to tereo; the outbox
      // reaper inside it runs only where `outbox.dispatch` allows.
      await getTereo().start();

      if (runsApi) {
        // Before listening: an invalid set must stop the start, not serve with
        // the kinds of the last good one.
        try {
          await provision();
        } catch (err) {
          if (err instanceof ProvisioningError) {
            for (const problem of err.problems)
              logger.error({ ...problem }, "Invalid provisioning");
          }
          throw err;
        }

        // Events recorded today and tomorrow need their partitions even while
        // the worker, which creates them a week ahead, is down.
        await ensureEventPartitions();
        // It gives up quietly when the table is locked; serving without
        // today's partition would fail every write.
        await assertCurrentPartitions();

        // Imported after Redis is up, as the modules behind it may resolve the
        // client when they load.
        const { default: app } = await import("./app.js");
        server = createServer(app);
        tuneServerKeepAlive(server);
        await attachSockets(server);

        const listening = server;
        await new Promise<void>((resolve, reject) => {
          listening.once("error", reject);
          listening.listen(port, () => {
            listening.off("error", reject);
            logger.info({ port, role: env.ROLE }, "homileo listening");
            resolve();
          });
        });
      }

      if (runsWorker) await startWorker();
    },

    stop: () => {
      if (!running) return Promise.resolve();
      // A second signal mid-shutdown waits on the first instead of closing
      // everything twice.
      stopping ??= (async () => {
        // Every step runs even if an earlier one fails, so a failed start
        // or a broken step still releases Redis and the database.
        const failures: unknown[] = [];
        const step = async (name: string, run: () => Promise<void>) => {
          try {
            await run();
          } catch (err) {
            failures.push(err);
            logger.error({ err, step: name }, "Shutdown step failed");
          }
        };

        // Drain HTTP before tearing anything down: handlers would otherwise
        // throw "pool ended" / "client closed" mid-flight.
        if (server) {
          const closing = server;
          server = null;
          // The HTTP server's close waits on upgraded connections, so the
          // sockets close alongside it; their Redis clients stay up until it drains.
          await step("http", async () => {
            await closeHttpServer(closing, disconnectSockets, DRAIN_TIMEOUT_MS);
            logger.info("HTTP server closed");
          });
        }
        await step("sockets", closeSockets);
        await step("worker", stopWorker);
        await step("tereo", stopTereo);
        await step("redis", closeRedisConnection);
        await step("database", disconnectDatabase);
        running = false;
        logger.info("Server closed");
        if (failures.length > 0) {
          throw new AggregateError(failures, "Shutdown did not complete");
        }
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    isRunning: () => running,
  };
}

// Started directly (`node dist/index.js`), not imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const appServer = createAppServer();

  appServer.start().catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Shutdown already in progress");
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down server...");
    try {
      await appServer.stop();
    } catch {
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException");
    // In production, let the orchestrator restart us: a process kept alive
    // after an uncaught exception often carries subtly corrupted state.
    if (env.NODE_ENV === "production") process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandledRejection");
    if (env.NODE_ENV === "production") process.exit(1);
  });
}
