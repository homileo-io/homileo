import { processEventPartitions } from "./jobs/eventPartitions.js";
import { processAttachmentKeeps } from "./jobs/attachmentKeep.js";
import { processEventRetention } from "./jobs/eventRetention.js";
import { logger } from "./utils/logger.js";

// Background work: daily event partitions and their retention, and keeping
// attachments whose send did not clear their expiry. Runs in
// processes started with ROLE=worker or ROLE=all. The tereo client, whose
// outbox reaper is gated by ROLE, starts and stops in createAppServer for
// every role.

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_INTERVAL_MS = 10 * 60 * 1000;

let partitionTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let keepTimer: NodeJS.Timeout | null = null;
// Where the next keep run starts; at process start, as far back as a placeholder lives.
let keepFrom = new Date(0);

const runPartitions = async (): Promise<void> => {
  try {
    await processEventPartitions();
  } catch (err) {
    // The next run retries; the API also covers today and tomorrow at start.
    logger.warn({ err }, "Event partition run failed");
  }
};

const runRetention = async (): Promise<void> => {
  try {
    await processEventRetention();
  } catch (err) {
    // The next run retries; an old partition only costs disk.
    logger.warn({ err }, "Event retention run failed");
  }
};

const runKeeps = async (): Promise<void> => {
  try {
    keepFrom = await processAttachmentKeeps(keepFrom);
  } catch (err) {
    // The next run starts from the same place.
    logger.warn({ err }, "Attachment keep run failed");
  }
};

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

/** Stops the schedule. */
export async function stopWorker(): Promise<void> {
  if (partitionTimer) clearInterval(partitionTimer);
  partitionTimer = null;
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
}
