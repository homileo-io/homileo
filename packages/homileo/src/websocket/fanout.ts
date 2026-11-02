import type { AppRemoteSocket, AppSocket, IOServer } from "./types.js";
import type { ChangeEvent } from "../utils/changes.js";
import type { Caller } from "../middleware/auth.js";
import { NotFoundError } from "../utils/errors.js";
import { changeBus } from "../utils/changeBus.js";
import { prisma } from "../utils/db/prisma.js";
import { eventView } from "../views/event.js";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import {
  type Audience,
  eventAudience,
  foundersOf,
  mentionedMessageOf,
  targetOf,
} from "../realtime/audience.js";
import {
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../realtime/rooms.js";
import {
  currentMentionReaders,
  moderatingCallers,
  readableSession,
  readableSpace,
} from "../utils/access.js";
import {
  leaveRooms,
  leaveSpaceOfIfUnused,
  recheckSockets,
  socketsReadingSession,
  sweepSockets,
} from "./rooms.js";

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

/** Whether `caller` can still read what a revocation reports lost. */
const stillReads = async (caller: Caller, e: ChangeEvent): Promise<boolean> => {
  try {
    if (e.type === "session.access_revoked") {
      const sessionId = field(e.payload, "sessionId");
      if (!sessionId) return false;
      await readableSession(caller, sessionId);
    } else {
      const spaceId = field(e.payload, "spaceId");
      if (!spaceId) return false;
      await readableSpace(caller, spaceId);
    }
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
};

/**
 * A removal takes the target's sockets out of the resource's room whatever they can still
 * read: following it again is a `subscribe`.
 */
const removedFrom = (e: ChangeEvent): string | null => {
  if (e.type === "session.participant_removed" && e.sessionId) {
    return sessionRoom(e.sessionId);
  }
  if (e.type === "space.member_removed" && e.spaceId) {
    return spaceRoom(e.spaceId);
  }
  return null;
};

/**
 * The rooms whose sockets an update may have locked out: only a space turning from public to
 * members-only narrows access. A session's `access` cannot be changed.
 */
const updatedRooms = (e: ChangeEvent): string[] => {
  if (e.type !== "space.updated" || !e.spaceId) return [];
  const payload = e.payload as Record<string, unknown> | null;
  const narrowed =
    field(payload, "previousVisibility") === "public" &&
    field(payload?.space, "visibility") !== "public";
  return narrowed ? [spaceRoom(e.spaceId), spaceOfRoom(e.spaceId)] : [];
};

/**
 * Re-checks the sockets in `rooms` before an update reaches them, and says which sockets may
 * be sent it: all of them, only this node's (the cluster-wide re-check failed, a local one
 * did not), or none.
 */
const recheckUpdated = async (
  io: IOServer,
  e: ChangeEvent,
  rooms: string[]
): Promise<"all" | "local" | "none"> => {
  const log = { eventId: e.id.toString(), type: e.type };
  try {
    await recheckSockets(await socketsIn(io, rooms));
    return "all";
  } catch (err) {
    logger.error(
      { err, ...log },
      "Re-checking the updated rooms' sockets failed; sending to this node's only"
    );
  }
  try {
    await recheckSockets(await io.local.in(rooms).fetchSockets());
    return "local";
  } catch (err) {
    logger.error(
      { err, ...log },
      "Re-checking this node's sockets in the updated rooms failed; not sending to them"
    );
    return "none";
  }
};

/**
 * Joins each principal's sockets to its room: this node's at once, so the emit that follows
 * finds them there, then other nodes' by socket id. Then re-checks them, so an add that fans
 * out after a later removal cannot leave a removed principal in the room.
 */
const joinAudience = async (
  io: IOServer,
  e: ChangeEvent,
  join: Audience["join"]
): Promise<void> => {
  const owners = new Set<string>();
  const roomsOf = new Map<string, string[]>();
  const joined = new Map<string, AppSocket | AppRemoteSocket>();
  for (const { principalId, room } of join) {
    const owner = userRoom(e.organizationId, principalId);
    owners.add(owner);
    roomsOf.set(principalId, [...(roomsOf.get(principalId) ?? []), room]);
    for (const socket of await io.local.in(owner).fetchSockets()) {
      joined.set(socket.id, socket);
      // The room is now the principal's own, not a subscription. Other nodes' lists are out
      // of reach: a subscribe at the cap, and the sweep, prune them there.
      socket.data.subscriptions.delete(room);
      await socket.join(room);
    }
  }
  const rooms = join.map((j) => j.room);
  // This node's first, so a Redis failure fetching the others' cannot skip it.
  await recheckSockets([...joined.values()], rooms);
  // By id, not by a join to the personal room: that would come back to this node through
  // Redis too, and could join a socket that connected since after a removal skipped it. A
  // socket of this node that connected since loaded its rooms after the commit.
  const local = io.of("/").sockets;
  const remote = (await socketsIn(io, [...owners])).filter(
    (s) => !joined.has(s.id) && !local.has(s.id) && s.data?.caller
  );
  for (const socket of remote) {
    const own = roomsOf.get(socket.data.caller.principalId);
    if (own) socket.join(own);
  }
  // A remote socket's leave is published after its join, so Redis delivers them in order.
  await recheckSockets(remote, rooms);
};

const socketsIn = (
  io: IOServer,
  rooms: string[]
): Promise<(AppSocket | AppRemoteSocket)[]> => io.in(rooms).fetchSockets();

/** The sockets in `rooms` on every node, or this node's only when the others' fetch fails. */
const socketsOrLocal = async (
  io: IOServer,
  e: ChangeEvent,
  rooms: string[]
): Promise<(AppSocket | AppRemoteSocket)[]> => {
  try {
    return await socketsIn(io, rooms);
  } catch (err) {
    logger.error(
      { err, eventId: e.id.toString(), type: e.type },
      "Fetching the sockets of every node failed; acting on this node's only"
    );
    return io.local.in(rooms).fetchSockets();
  }
};

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

/**
 * The mentioned principals each message event still reaches beyond its session room, by
 * message id. Participants who joined by the message's first event in the batch are left out:
 * the room reaches them, under its own checks, as `/sync` reaches a participant only while they
 * can read the session. One who joined later may not be in the room yet.
 */
const loadMentions = async (
  events: ChangeEvent[]
): Promise<Map<string, string[]>> => {
  try {
    const firstEventAt = new Map<string, Date>();
    for (const e of events) {
      const id = mentionedMessageOf(e);
      const seen = id ? firstEventAt.get(id) : undefined;
      if (id && (!seen || e.createdAt < seen))
        firstEventAt.set(id, e.createdAt);
    }
    const stored = await db.messages.storedMentionsOf(prisma, [
      ...firstEventAt.keys(),
    ]);
    return currentMentionReaders(
      stored.filter(
        (m) =>
          m.participantJoinedAt === null ||
          m.participantJoinedAt > firstEventAt.get(m.messageId)!
      )
    );
  } catch (err) {
    // The messages still reach their sessions' rooms; mentioned readers outside them
    // catch up through /sync.
    logger.error({ err }, "Loading the mentions to push failed");
    return new Map();
  }
};

/** The sockets in the space's room whose own caller can moderate it. */
const moderatorSockets = async (
  io: IOServer,
  spaceId: string
): Promise<string[]> => {
  const sockets = (await socketsIn(io, [spaceRoom(spaceId)])).filter(
    (s) => s.data?.caller
  );
  const can = await moderatingCallers(
    sockets.map((s) => s.data.caller),
    spaceId
  );
  return sockets.flatMap((s, i) => (can[i] ? [s.id] : []));
};

/**
 * The sockets of the batch's mentioned principals, fetched from every node once, on first
 * use: a mention event then takes those in its own `mentioned` rooms.
 */
const mentionSockets = (io: IOServer, audiences: Audience[]) => {
  let fetched: Promise<(AppSocket | AppRemoteSocket)[]> | null = null;
  return async (rooms: string[]) => {
    fetched ??= socketsIn(io, [
      ...new Set(audiences.flatMap((a) => a.mentioned)),
    ]);
    const wanted = new Set(rooms);
    return (await fetched).filter(
      (s) =>
        s.data?.caller &&
        wanted.has(
          userRoom(s.data.caller.organizationId, s.data.caller.principalId)
        )
    );
  };
};

const fanOut = async (io: IOServer, events: ChangeEvent[]): Promise<void> => {
  const mentions = await loadMentions(events);
  const audiences = events.map((e) => {
    const messageId = mentionedMessageOf(e);
    return eventAudience(
      e,
      messageId ? (mentions.get(messageId) ?? []) : [],
      foundersOf(e, events)
    );
  });
  const mentionedSockets = mentionSockets(io, audiences);

  for (const [i, e] of events.entries()) {
    const audience = audiences[i];
    const view = eventView(e);

    if (audience.join.length > 0) {
      await step(e, "join", () => joinAudience(io, e, audience.join));
    }

    // Before the emit, so a socket that just lost access does not get the update.
    const updated = updatedRooms(e);
    const reach =
      updated.length > 0 ? await recheckUpdated(io, e, updated) : "all";

    let moderators: string[] = [];
    const moderated = audience.moderators;
    if (moderated) {
      await step(e, "moderators", async () => {
        moderators = await moderatorSockets(io, moderated);
      });
    }
    let mentioned: string[] = [];
    const { sessionId } = e;
    if (audience.mentioned.length > 0 && sessionId) {
      // On failure the mentioned non-participants catch up through /sync.
      await step(e, "mentions", async () => {
        mentioned = await socketsReadingSession(
          await mentionedSockets(audience.mentioned),
          sessionId
        );
      });
    }
    // socket.io sends once per socket across the union of the rooms; a socket id is a room.
    const to = [...audience.rooms, ...moderators, ...mentioned];
    if (reach === "all") {
      if (to.length > 0) io.to(to).emit(e.type, view);
    } else {
      const rest = to.filter((room) => !updated.includes(room));
      if (rest.length > 0) io.to(rest).except(updated).emit(e.type, view);
      if (reach === "local") io.local.to(updated).emit(e.type, view);
    }

    const removed = removedFrom(e);
    const target = targetOf(e);
    if (removed && target) {
      await step(e, "removal", async () => {
        const sockets = await socketsOrLocal(io, e, [
          userRoom(e.organizationId, target),
        ]);
        // Whether or not the fetch saw it in the room: a join may still be in flight.
        for (const socket of sockets) {
          await leaveRooms(socket, [removed]);
          if (e.type === "session.participant_removed" && e.spaceId) {
            await leaveSpaceOfIfUnused(socket, e.spaceId, removed);
          }
        }
      });
    }

    // A revocation goes to no room: only to the sockets that really lost the resource,
    // judged by their own token, whether or not they were following it. Its removal event
    // comes earlier in the batch, so the target has that already.
    await step(e, "revocation", async () => {
      for (const principalId of audience.recheck) {
        const sockets = await socketsOrLocal(io, e, [
          userRoom(e.organizationId, principalId),
        ]);
        await recheckSockets(sockets);
        const lost: string[] = [];
        for (const socket of sockets) {
          if (!(await stillReads(socket.data.caller, e))) lost.push(socket.id);
        }
        if (lost.length > 0) io.to(lost).emit(e.type, view);
      }
    });
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
      sweepSockets(io).catch((err: unknown) => {
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
