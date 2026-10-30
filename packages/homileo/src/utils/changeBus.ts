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
