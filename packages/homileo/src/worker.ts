import { processEventPartitions } from "./jobs/eventPartitions.js";
import { getTereo } from "./utils/tereo.js";
import { logger } from "./utils/logger.js";

// Background work: daily event partitions and tereo's outbox reaper. Runs in
// processes started with ROLE=worker or ROLE=all.

const DAY_MS = 24 * 60 * 60 * 1000;

let partitionTimer: NodeJS.Timeout | null = null;

const runPartitions = async (): Promise<void> => {
  try {
    await processEventPartitions();
  } catch (err) {
    // The next run retries; the API also covers today and tomorrow at start.
    logger.warn({ err }, "Event partition run failed");
  }
};

export async function startWorker(): Promise<void> {
  if (partitionTimer) return;
  await runPartitions();
  partitionTimer = setInterval(() => void runPartitions(), DAY_MS);
  partitionTimer.unref();

  // Fans events recorded in the outbox out to tereo.
  await getTereo().start();
  logger.info("homileo worker started");
}

/**
 * Stops the schedule. The reaper stops with `stopTereo()`, which index.ts
 * runs after the HTTP server has drained.
 */
export async function stopWorker(): Promise<void> {
  if (partitionTimer) clearInterval(partitionTimer);
  partitionTimer = null;
}
