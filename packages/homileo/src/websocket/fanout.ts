import { eventAudience, mentionedMessageOf } from "../realtime/audience.js";
import type { AppRemoteSocket, AppSocket, IOServer } from "./types.js";
import type { ChangeEvent } from "../utils/changes.js";
import { changeBus } from "../utils/changeBus.js";
import { prisma } from "../utils/db/prisma.js";
import { eventView } from "../views/event.js";
import { logger } from "../utils/logger.js";
import { recheckSockets } from "./rooms.js";
import { db } from "../utils/db/index.js";
import {
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../realtime/rooms.js";

/** The backstop re-check of every local socket, for access lost without an event. */
export const SWEEP_INTERVAL_MS = 300_000;

interface Fanout {
  listener: (events: ChangeEvent[]) => void;
  sweep: NodeJS.Timeout;
  /** The batch in flight; batches run one after another, in commit order. */
  queue: Promise<void>;
}

const running = new WeakMap<IOServer, Fanout>();

const field = (payload: unknown, key: string): string | null => {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : null;
};

/** The rooms whose loss a revocation reports. */
const revokedRooms = (e: ChangeEvent): string[] => {
  if (e.type === "session.access_revoked") {
    const sessionId = field(e.payload, "sessionId");
    return sessionId ? [sessionRoom(sessionId)] : [];
  }
  const spaceId = field(e.payload, "spaceId");
  return spaceId ? [spaceRoom(spaceId), spaceOfRoom(spaceId)] : [];
};

/**
 * The rooms whose sockets an update may have locked out. The payload holds only the new
 * state, so an update that leaves a space members-only (a rename, say) still re-checks;
 * one that leaves it public, or a session's read following its space, cannot lock anyone out.
 */
const updatedRooms = (e: ChangeEvent): string[] => {
  const state = (e.payload as Record<string, unknown> | null) ?? {};
  if (e.type === "space.updated" && e.spaceId) {
    if (field(state.space, "visibility") === "public") return [];
    return [spaceRoom(e.spaceId), spaceOfRoom(e.spaceId)];
  }
  if (e.type === "session.updated" && e.sessionId) {
    if (field(state.session, "access") === "space") return [];
    return [sessionRoom(e.sessionId)];
  }
  return [];
};

const socketsIn = (
  io: IOServer,
  rooms: string[]
): Promise<(AppSocket | AppRemoteSocket)[]> => io.in(rooms).fetchSockets();

/** Runs one step of an event's fan-out; a failure is logged and the rest go on. */
const step = async (
  e: ChangeEvent,
  name: string,
  run: () => Promise<void>
): Promise<void> => {
  try {
    await run();
  } catch (err) {
    logger.error(
      { err, eventId: e.id.toString(), type: e.type, step: name },
      "A step of pushing an event to sockets failed"
    );
  }
};

/** Stored mentions name only principals who could read the session when it was written. */
const loadMentions = async (
  events: ChangeEvent[]
): Promise<Map<string, string[]>> => {
  try {
    return await db.messages.mentionedUserIdsOf(
      prisma,
      events.flatMap((e) => mentionedMessageOf(e) ?? [])
    );
  } catch (err) {
    // The messages still reach their sessions' rooms; mentioned readers outside them
    // catch up through /sync.
    logger.error({ err }, "Loading the mentions to push failed");
    return new Map();
  }
};

const fanOut = async (io: IOServer, events: ChangeEvent[]): Promise<void> => {
  const mentions = await loadMentions(events);

  for (const e of events) {
    const messageId = mentionedMessageOf(e);
    const audience = eventAudience(
      e,
      messageId ? (mentions.get(messageId) ?? []) : []
    );
    const view = eventView(e);

    await step(e, "join", async () => {
      for (const { principalId, room } of audience.join) {
        const owner = userRoom(e.organizationId, principalId);
        // Synchronous for this node's sockets, so the emit below finds them in the room.
        io.in(owner).socketsJoin(room);
        // The room is now the principal's own, not a subscription. Other nodes' lists are
        // out of reach: their `unsubscribe` checks participation and membership instead.
        for (const socket of await io.local.in(owner).fetchSockets()) {
          socket.data.subscriptions.delete(room);
        }
      }
    });

    // socket.io sends once per socket across the union of the rooms.
    if (audience.rooms.length > 0) io.to(audience.rooms).emit(e.type, view);

    // A revocation goes to no room: only to the sockets that really lost the resource.
    // Its removal event comes earlier in the batch, so the target has that already.
    await step(e, "revocation", async () => {
      for (const principalId of audience.recheck) {
        const sockets = await socketsIn(io, [
          userRoom(e.organizationId, principalId),
        ]);
        const left = await recheckSockets(sockets);
        const reported = revokedRooms(e);
        const lost = [...left]
          .filter(([, rooms]) => rooms.some((r) => reported.includes(r)))
          .map(([id]) => id);
        if (lost.length > 0) io.to(lost).emit(e.type, view);
      }
    });

    const updated = updatedRooms(e);
    if (updated.length > 0) {
      await step(e, "update recheck", async () => {
        await recheckSockets(await socketsIn(io, updated));
      });
    }
  }
};

/**
 * Pushes each transaction this process commits to the sockets of every node, through the
 * adapter, and re-checks the sockets that may have lost access; and sweeps this node's
 * sockets every `SWEEP_INTERVAL_MS`. Started once per node, on the node's socket server.
 */
export const startFanout = (io: IOServer): void => {
  if (running.has(io)) throw new Error("Fan-out is already running");
  const fanout: Fanout = {
    queue: Promise.resolve(),
    listener: (events) => {
      fanout.queue = fanout.queue.then(() =>
        fanOut(io, events).catch((err: unknown) => {
          logger.error(
            { err, eventIds: events.map((e) => e.id.toString()) },
            "Pushing committed events to sockets failed"
          );
        })
      );
    },
    sweep: setInterval(() => {
      io.local
        .fetchSockets()
        .then(recheckSockets)
        .catch((err: unknown) => {
          logger.error({ err }, "Re-checking the sockets' rooms failed");
        });
    }, SWEEP_INTERVAL_MS).unref(),
  };
  running.set(io, fanout);
  changeBus.on("committed", fanout.listener);
};

/** Stops listening and sweeping, then waits for the batches already taken. */
export const stopFanout = async (io: IOServer): Promise<void> => {
  const fanout = running.get(io);
  if (!fanout) return;
  running.delete(io);
  changeBus.off("committed", fanout.listener);
  clearInterval(fanout.sweep);
  await fanout.queue;
};
