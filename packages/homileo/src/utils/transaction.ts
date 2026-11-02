import { recordChange, type ChangeEvent, type ChangeInput } from "./changes.js";
import { setInTransaction, warmKinds } from "./kinds.js";
import { publishCommitted } from "./changeBus.js";
import type { Prisma } from "./db/prisma.js";
import { prisma } from "./db/prisma.js";
import env from "../env.js";

/**
 * Runs `fn` in one transaction. `record` writes a change in it; once the
 * transaction has committed, the events it recorded go out on `changeBus`
 * together, in order. A rollback sends none. A lock wait longer than
 * DB_LOCK_TIMEOUT_MS fails the transaction (503, `isDatabaseBusy`).
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
  const result = await prisma.$transaction(async (tx) => {
    // SET takes no parameters; the value is an integer from the env schema.
    await tx.$executeRawUnsafe(
      `SET LOCAL lock_timeout = ${env.DB_LOCK_TIMEOUT_MS}`
    );
    setInTransaction(1);
    try {
      return await fn(tx, async (change) => {
        const event = await recordChange(tx, change);
        events.push(event);
        return event;
      });
    } finally {
      setInTransaction(-1);
    }
  });
  if (events.length > 0) publishCommitted(events);
  return result;
};
