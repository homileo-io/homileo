import { ensureEventPartitions } from "../utils/partitions.js";
import { logger } from "../utils/logger.js";

/** Run daily by the worker, so a week of partitions is always ahead. */
export const processEventPartitions = async (): Promise<number> => {
  const ensured = await ensureEventPartitions();
  logger.info({ ensured }, "Event partitions ensured");
  return ensured;
};
