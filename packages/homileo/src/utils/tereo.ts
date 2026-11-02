import { createCoreClient, type CoreClient } from "@tereo-io/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { webhookEventTypes } from "@homileo-io/sdk";
import { prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";
import env from "../env.js";

let client: CoreClient | null = null;

const transactionScope = new AsyncLocalStorage<true>();

/** `withChanges` runs its callback through this, for `assertNoTransaction`. */
export const runInTransactionScope = <T>(fn: () => Promise<T>): Promise<T> =>
  transactionScope.run(true, fn);

/**
 * In test mode, throws when a call to tereo runs inside a `withChanges`
 * transaction: the round trip would hold the transaction's row locks and its
 * connection. Production skips the check.
 */
export const assertNoTransaction = (call: string): void => {
  if (env.TEREO_TEST_MODE && transactionScope.getStore()) {
    throw new Error(`${call} called inside a withChanges transaction`);
  }
};

/** In test mode, `target` with every method call checked by `assertNoTransaction`. */
export const guardTereoCalls = <T extends object>(
  name: string,
  target: T
): T =>
  env.TEREO_TEST_MODE
    ? new Proxy(target, {
        get(t, prop, receiver) {
          const value: unknown = Reflect.get(t, prop, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            assertNoTransaction(`tereo ${name}.${String(prop)}()`);
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      })
    : target;

// The outbox is left out: it writes in the caller's transaction, not to tereo.
const NETWORK_CLIENTS = [
  "auth",
  "files",
  "webhooks",
  "audit",
  "notifications",
] as const;

const guardClient = (created: CoreClient): CoreClient => {
  const parts = new Map<PropertyKey, object>(
    NETWORK_CLIENTS.map((name) => [name, guardTereoCalls(name, created[name])])
  );
  return new Proxy(created, {
    get: (t, prop, receiver) =>
      parts.get(prop) ?? Reflect.get(t, prop, receiver),
  });
};

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
  const created = createCoreClient({
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
      // In test mode tereo is a placeholder URL, so the reaper would only fail
      // to deliver; rows stay in the outbox for tests to inspect.
      dispatch: env.ROLE !== "api" && !testMode,
    },
    testMode,
  });
  client = testMode ? guardClient(created) : created;
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
