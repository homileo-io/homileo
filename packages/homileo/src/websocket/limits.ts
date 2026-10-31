import type { AppSocket } from "./types.js";
import { logger } from "../utils/logger.js";

/** Sockets one principal may hold on one node. */
export const MAX_SOCKETS_PER_PRINCIPAL = 20;
/** Larger packets close the connection. */
export const MAX_PACKET_BYTES = 16 * 1024;
/** Client events one socket may send in any one second. */
export const MAX_EVENTS_PER_SECOND = 20;
export const MAX_SUBSCRIPTIONS = 200;

const socketsPerPrincipal = new Map<string, number>();

/**
 * Takes one of the principal's slots for the socket, or refuses it. Counted at the handshake,
 * so handshakes in flight together cannot pass the cap. The slot is freed once, at the socket's
 * disconnect or its connection's close: a client gone before the handshake finished never
 * connects, and only the connection's close says so.
 */
export const claimSocketSlot = (
  socket: AppSocket,
  next: (err?: Error) => void
): void => {
  const { principalId } = socket.data.caller;
  const held = socketsPerPrincipal.get(principalId) ?? 0;
  if (held >= MAX_SOCKETS_PER_PRINCIPAL) {
    next(new Error("too_many_connections"));
    return;
  }
  // Closed while the handshake awaited the database: no close event is left.
  if (socket.conn.readyState !== "open") {
    next(new Error("connection_closed"));
    return;
  }
  socketsPerPrincipal.set(principalId, held + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (socketsPerPrincipal.get(principalId) ?? 1) - 1;
    if (left > 0) socketsPerPrincipal.set(principalId, left);
    else socketsPerPrincipal.delete(principalId);
  };
  socket.on("disconnect", release);
  socket.conn.once("close", release);
  next();
};

/**
 * Drops the events past `MAX_EVENTS_PER_SECOND` in a sliding second, answering each dropped
 * event's ack with `rate_limited`. A dropped event does not count against the next second.
 */
export const limitEvents = (socket: AppSocket): void => {
  const recent: number[] = [];
  socket.use((packet, next) => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0] >= 1000) recent.shift();
    if (recent.length < MAX_EVENTS_PER_SECOND) {
      recent.push(now);
      next();
      return;
    }
    logger.debug(
      { principalId: socket.data.caller.principalId, event: packet[0] },
      "Socket event rate limited"
    );
    const ack = packet[packet.length - 1];
    if (typeof ack === "function") {
      ack({
        ok: false,
        error: {
          code: "rate_limited",
          message: `At most ${MAX_EVENTS_PER_SECOND} events a second`,
        },
      });
    }
  });
};
