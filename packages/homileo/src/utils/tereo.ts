import { createCoreClient, type CoreClient } from "@tereo-io/sdk";
import { webhookEventTypes } from "@homileo-io/sdk";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";
import env from "../env.js";

let client: CoreClient | null = null;

/** The one tereo client; `initializeTereo()` must have run. */
export const getTereo = (): CoreClient => {
  if (!client) {
    throw new Error("tereo client is not initialized; call initializeTereo()");
  }
  return client;
};

/**
 * Creates the client; the outbox reaper starts separately, with `start()`.
 * In test mode nothing reaches tereo, so the connection values the SDK insists
 * on may be absent from the environment.
 */
export const initializeTereo = async (): Promise<void> => {
  if (client) {
    logger.warn("tereo client already initialized");
    return;
  }
  const testMode = env.TEREO_TEST_MODE;
  // The placeholders apply only in test mode, which env.ts refuses in production.
  client = createCoreClient({
    service: env.TEREO_SERVICE_SLUG,
    url: env.TEREO_URL ?? (testMode ? "http://localhost:1" : undefined),
    clientId: env.TEREO_CLIENT_ID ?? (testMode ? "test-client" : undefined),
    clientSecret:
      env.TEREO_CLIENT_SECRET ?? (testMode ? "test-secret" : undefined),
    requestHandlerKey:
      env.REQUEST_HANDLER_KEY ??
      (testMode ? "test-request-handler-key-0123456789ab" : undefined),
    redis,
    eventTypes: webhookEventTypes(),
    outbox: {
      db: prisma,
      table: "core.core_outbox",
      dispatch: env.ROLE !== "api",
    },
    testMode,
  });
  logger.info(
    { service: env.TEREO_SERVICE_SLUG, testMode },
    "tereo client created"
  );
};

export const stopTereo = async (): Promise<void> => {
  if (!client) return;
  const closing = client;
  client = null;
  await closing.stop();
};
