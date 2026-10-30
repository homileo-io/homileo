import { recordChange, type ChangeEvent, type ChangeInput } from "./changes.js";
import type { Prisma } from "./db/prisma.js";
import { changeBus } from "./changeBus.js";
import { prisma } from "./db/prisma.js";
import { warmKinds } from "./kinds.js";
import { logger } from "./logger.js";

/**
 * Runs `fn` in one transaction. `record` writes a change in it; once the
 * transaction has committed, the events it recorded go out on `changeBus`
 * together, in order. A rollback sends none.
 *
 * The kind cache is loaded first: loading it inside, while `fn` holds row
 * locks, would wait on a second connection.
 */
export const withChanges = async <T>(
  fn: (
    tx: Prisma.TransactionClient,
    record: (change: ChangeInput) => Promise<ChangeEvent>
  ) => Promise<T>
): Promise<T> => {
  await warmKinds();
  const events: ChangeEvent[] = [];
  const result = await prisma.$transaction(async (tx) =>
    fn(tx, async (change) => {
      const event = await recordChange(tx, change);
      events.push(event);
      return event;
    })
  );
  if (events.length > 0) {
    // The change is committed: a failing listener must not turn it into an error.
    try {
      changeBus.emit("committed", events);
    } catch (err) {
      logger.error({ err }, "A change bus listener failed");
    }
  }
  return result;
};
