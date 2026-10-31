import { dropExpiredPartitions, utcDay } from "../utils/partitions.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";

/** Run daily by the worker: drops the partitions past EVENT_RETENTION_DAYS. */
export const processEventRetention = async (): Promise<string[]> => {
  const dropped = await dropExpiredPartitions(
    utcDay(),
    env.EVENT_RETENTION_DAYS
  );
  if (dropped.length > 0) logger.info({ dropped }, "Event partitions dropped");
  return dropped;
};
