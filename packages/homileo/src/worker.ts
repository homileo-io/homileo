import { processEventPartitions } from "./jobs/eventPartitions.js";
import { processEventRetention } from "./jobs/eventRetention.js";
import { logger } from "./utils/logger.js";
import env from "./env.js";
import {
  processAttachmentKeeps,
  START_OF_KEEPS,
} from "./jobs/attachmentKeep.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_INTERVAL_MS = 10 * 60 * 1000;

let partitionTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let keepTimer: NodeJS.Timeout | null = null;
// Where the next keep run starts; at process start, as far back as a placeholder lives.
let keepFrom = START_OF_KEEPS;

const inFlight = new Set<Promise<void>>();

const tracked = (run: () => Promise<void>) => (): Promise<void> => {
  const running = run().finally(() => inFlight.delete(running));
  inFlight.add(running);
  return running;
};

const runPartitions = tracked(async () => {
  try {
    await processEventPartitions();
  } catch (err) {
    // The next run retries; the API also covers today and tomorrow at start.
    logger.warn({ err }, "Event partition run failed");
  }
});

const runRetention = tracked(async () => {
  try {
    await processEventRetention();
  } catch (err) {
    // The next run retries; an old partition only costs disk.
    logger.warn({ err }, "Event retention run failed");
  }
});

let keepRunning = false;

const runKeeps = tracked(async () => {
  // A run slower than the interval would otherwise overlap the next one and
  // could move keepFrom backwards when it finishes last.
  if (keepRunning) return;
  keepRunning = true;
  try {
    keepFrom = await processAttachmentKeeps(keepFrom);
  } catch (err) {
    // The next run starts from the same place.
    logger.warn({ err }, "Attachment keep run failed");
  } finally {
    keepRunning = false;
  }
});

export async function startWorker(): Promise<void> {
  if (partitionTimer) return;
  await runPartitions();
  partitionTimer = setInterval(() => void runPartitions(), DAY_MS);
  partitionTimer.unref();
  await runRetention();
  retentionTimer = setInterval(() => void runRetention(), DAY_MS);
  retentionTimer.unref();
  await runKeeps();
  keepTimer = setInterval(() => void runKeeps(), KEEP_INTERVAL_MS);
  keepTimer.unref();
  logger.info("homileo worker started");
}

/**
 * Stops the schedule and waits up to `waitMs` for the runs in flight; past
 * that it returns while they run on. Closing the database does not fail them:
 * `disconnectDatabase` waits a bounded time for their connections, then leaves
 * them to the process exit.
 */
export async function stopWorker(
  waitMs: number = env.SHUTDOWN_TIMEOUT_SECONDS * 1000
): Promise<void> {
  if (partitionTimer) clearInterval(partitionTimer);
  partitionTimer = null;
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;

  if (inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const finished = await Promise.race([
    Promise.allSettled([...inFlight]).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, waitMs));
    }),
  ]);
  clearTimeout(timer);
  if (!finished) {
    logger.warn(
      { running: inFlight.size },
      "Worker jobs still running at shutdown"
    );
  }
}
