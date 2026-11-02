import { callerFromToken } from "../middleware/auth.js";
import type { AppSocket, IOServer } from "./types.js";
import { canReadChat } from "../policy/chat.js";
import { isDeepStrictEqual } from "node:util";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { recheckSockets } from "./rooms.js";

/** How often each node introspects its sockets' tokens again. */
export const TOKEN_RECHECK_INTERVAL_MS = 60_000;
/** Introspections in flight at once during a re-check. */
const TOKEN_RECHECK_CONCURRENCY = 10;

// Kept off `socket.data`, which the adapter sends to other nodes in `fetchSockets` replies.
const tokens = new WeakMap<AppSocket, string>();

/**
 * Checks the handshake's `auth.token` as `authenticate` checks a request's, and sets
 * `socket.data`. A refusal's message is its code: `unauthorized`, `organization_required`, or
 * `forbidden` for a token without `homileo.spaces.read` (`canReadChat`).
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
    if (!canReadChat(caller)) {
      next(new Error("forbidden"));
      return;
    }
    socket.data = {
      caller,
      subscriptions: new Set(),
      watched: new Set(),
      exp,
    };
    tokens.set(socket, token);
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(new Error(err.code));
      return;
    }
    logger.error({ err }, "Socket handshake failed");
    next(new Error("server_error"));
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
  // Without an expiry, the periodic re-introspection is what closes it.
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

/**
 * Introspects the sockets' tokens again, once per distinct token, and closes the sockets of a
 * token tereo no longer accepts (revoked, expired, or tereo unreachable, as a request would be
 * refused). Sockets of a token still active take its current caller, and are re-checked when
 * its permissions changed.
 */
export const revalidateSockets = async (
  sockets: AppSocket[]
): Promise<void> => {
  const byToken = new Map<string, AppSocket[]>();
  for (const socket of sockets) {
    const token = tokens.get(socket);
    if (!token || socket.disconnected) continue;
    byToken.set(token, [...(byToken.get(token) ?? []), socket]);
  }
  const entries = [...byToken];
  for (let i = 0; i < entries.length; i += TOKEN_RECHECK_CONCURRENCY) {
    await Promise.all(
      entries
        .slice(i, i + TOKEN_RECHECK_CONCURRENCY)
        .map(([token, group]) => revalidateToken(token, group))
    );
  }
};

const revalidateToken = async (
  token: string,
  sockets: AppSocket[]
): Promise<void> => {
  try {
    const { caller } = await callerFromToken(token);
    // Socket actions rely on every connected socket's caller holding read, as the handshake checked.
    if (!canReadChat(caller)) {
      for (const socket of sockets) socket.disconnect(true);
      return;
    }
    const permissions = [...caller.permissions].sort();
    const changed = sockets.filter(
      (s) =>
        !isDeepStrictEqual([...s.data.caller.permissions].sort(), permissions)
    );
    for (const socket of sockets) socket.data.caller = caller;
    if (changed.length > 0) await recheckSockets(changed);
  } catch (err) {
    if (err instanceof AppError) {
      for (const socket of sockets) socket.disconnect(true);
      return;
    }
    logger.error(
      { err, principalId: sockets[0]?.data.caller.principalId },
      "Re-checking a socket's token failed"
    );
  }
};

/** Re-introspects this node's sockets' tokens every `TOKEN_RECHECK_INTERVAL_MS`. */
export const startTokenRecheck = (io: IOServer): (() => void) => {
  let running = false;
  const timer = setInterval(() => {
    // A run still going (tereo slow) is not overlapped.
    if (running) return;
    running = true;
    revalidateSockets([...io.of("/").sockets.values()])
      .catch((err: unknown) => {
        logger.error({ err }, "Re-checking the sockets' tokens failed");
      })
      .finally(() => {
        running = false;
      });
  }, TOKEN_RECHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};
