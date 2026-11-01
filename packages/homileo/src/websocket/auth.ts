import { callerFromToken } from "../middleware/auth.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { AppSocket } from "./types.js";

/**
 * Checks the handshake's `auth.token` as `authenticate` checks a request's, and sets
 * `socket.data`. A refusal's message is its code: `unauthorized` or `organization_required`.
 */
export const authenticateSocket = async (
  socket: AppSocket,
  next: (err?: Error) => void
): Promise<void> => {
  const token: unknown = socket.handshake.auth?.token;
  if (typeof token !== "string" || token === "") {
    next(new Error("unauthorized"));
    return;
  }
  try {
    const { caller, exp } = await callerFromToken(token);
    socket.data = {
      caller,
      subscriptions: new Set(),
      watched: new Set(),
      exp,
    };
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(new Error(err.code));
      return;
    }
    logger.error({ err }, "Socket handshake failed");
    next(new Error("internal_error"));
  }
};

// setTimeout's longest delay; a token living longer is checked again then.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Closes the socket when the token it connected with expires. The client reconnects with a
 * fresh one, whose permissions the handshake reads again.
 */
export const closeAtExpiry = (socket: AppSocket): void => {
  const { exp } = socket.data;
  if (exp === null) return;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const remaining = exp * 1000 - Date.now();
    if (remaining <= 0) {
      socket.disconnect(true);
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
    timer.unref();
  };
  arm();
  socket.on("disconnect", () => clearTimeout(timer));
};
