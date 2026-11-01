import type { ChangeEvent } from "./changes.js";
import { EventEmitter } from "node:events";
import { logger } from "./logger.js";

/**
 * `"committed"` carries the `ChangeEvent[]` of one transaction, in commit
 * order, after it commits. Sockets and the like subscribe to it.
 */
export const changeBus = new EventEmitter({ captureRejections: true });

// An async listener's rejection arrives here rather than as an unhandled one.
// Set as a method, not a listener, so `removeAllListeners()` leaves it be.
(changeBus as unknown as Record<symbol, unknown>)[
  Symbol.for("nodejs.rejection")
] = (err: unknown) => {
  logger.error({ err }, "A change bus listener failed");
};

/**
 * Calls each `"committed"` listener on its own, so one that throws or rejects
 * neither stops the rest nor reaches the caller.
 */
export const publishCommitted = (events: ChangeEvent[]): void => {
  for (const listener of changeBus.listeners("committed")) {
    const fail = (err: unknown) =>
      logger.error(
        { err, listener: listener.name },
        "A change listener failed"
      );
    try {
      const returned: unknown = listener(events);
      if (returned instanceof Promise) returned.catch(fail);
    } catch (err) {
      fail(err);
    }
  }
};
