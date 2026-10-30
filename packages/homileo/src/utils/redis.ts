import { redisRetryStrategy } from "./redisRetry.js";
import { logger } from "./logger.js";
import { Redis } from "ioredis";
import env from "../env.js";

const QUIT_TIMEOUT_MS = 2_000;

/**
 * The one Redis client. It connects in `initializeRedis()`, not on import, so
 * a module that only imports it (a unit test) opens no socket.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: redisRetryStrategy,
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis client error");
});

export const initializeRedis = async (): Promise<void> => {
  if (redis.status === "ready") {
    logger.warn("Redis client already initialized");
    return;
  }
  if (redis.status === "wait" || redis.status === "end") await redis.connect();
  await redis.ping();
  logger.info("Redis client initialized and verified");
};

/**
 * The client retries forever, so while Redis is unreachable QUIT waits in the
 * offline queue and never returns. Dropping the connection instead also ends
 * the reconnect loop; a QUIT that outlasts the timeout is dropped the same way.
 */
export const closeRedisConnection = async (): Promise<void> => {
  if (redis.status !== "ready") {
    redis.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), QUIT_TIMEOUT_MS);
  });
  const quit = redis.quit().then(
    () => true,
    () => false
  );
  try {
    if (!(await Promise.race([quit, timedOut]))) redis.disconnect();
  } finally {
    clearTimeout(timer);
  }
};
