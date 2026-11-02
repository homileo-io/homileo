import type { Ack, AckError, AppSocket, IOServer } from "./types.js";
import { readableSession, readableSpace } from "../utils/access.js";
import { NotFoundError, issuesOf } from "../utils/errors.js";
import { encodeSyncCursor } from "../realtime/syncCursor.js";
import { IdSchema } from "../utils/idSchema.js";
import { MAX_SUBSCRIPTIONS } from "./limits.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
import { failureAck } from "./failures.js";
import { db } from "../utils/db/index.js";
import { z } from "zod";
import {
  sessionIdOf,
  sessionRoom,
  spaceIdOf,
  spaceOfRoom,
  spaceRoom,
} from "../realtime/rooms.js";
import {
  leaveSpaceOfIfUnused,
  recheckSockets,
  roomsOnConnect,
} from "./rooms.js";

export const SubscriptionTargetSchema = z.union([
  z.strictObject({ sessionId: IdSchema }),
  z.strictObject({ spaceId: IdSchema }),
]);

const OK: Ack = { ok: true };

/** The rooms each socket's `subscribe` calls are joining and re-checking. */
const subscribing = new WeakMap<AppSocket, Set<string>>();

/**
 * A successful subscribe: `until`, taken once the socket is in the room, is where the
 * client's `/sync` for the resource must reach; later transactions fan out to the room.
 */
const subscribed = async (): Promise<Ack> => ({
  ok: true,
  until: encodeSyncCursor(await db.events.tail()),
});
const failure = (error: AckError): Ack => ({ ok: false, error });

const notFound = (target: { sessionId: string } | { spaceId: string }) =>
  failure({
    code: "not_found",
    message: "sessionId" in target ? "Session not found" : "Space not found",
  });

const parseTarget = (payload: unknown) => {
  const parsed = SubscriptionTargetSchema.safeParse(payload);
  if (parsed.success) return { target: parsed.data };
  return {
    error: failure({
      code: "invalid_request",
      message: "Expected exactly one of sessionId or spaceId",
      issues: issuesOf(parsed.error),
    }),
  };
};

const subscribe = async (socket: AppSocket, payload: unknown): Promise<Ack> => {
  const { target, error } = parseTarget(payload);
  if (!target) return error;
  const room =
    "sessionId" in target
      ? sessionRoom(target.sessionId)
      : spaceRoom(target.spaceId);
  // Already there, subscribed or for membership: nothing to count or check.
  if (socket.rooms.has(room)) return subscribed();

  const { subscriptions } = socket.data;
  const atLimit = async () => {
    if (subscriptions.size < MAX_SUBSCRIPTIONS) return false;
    // Another node's add joined some for participation or membership; it could not update
    // this list.
    const held = new Set(await roomsOnConnect(socket.data.caller));
    for (const r of subscriptions) if (held.has(r)) subscriptions.delete(r);
    return subscriptions.size >= MAX_SUBSCRIPTIONS;
  };
  const tooMany = failure({
    code: "too_many_subscriptions",
    message: `At most ${MAX_SUBSCRIPTIONS} subscriptions per socket`,
  });
  if (await atLimit()) return tooMany;

  let spaceId: string | null = null;
  try {
    if ("sessionId" in target) {
      ({
        session: { spaceId },
      } = await readableSession(socket.data.caller, target.sessionId));
    } else {
      await readableSpace(socket.data.caller, target.spaceId);
    }
  } catch (err) {
    if (err instanceof NotFoundError) return notFound(target);
    throw err;
  }

  // Subscribes in flight together all passed the first check.
  if (socket.rooms.has(room)) return subscribed();
  if (await atLimit()) return tooMany;
  subscriptions.add(room);
  const pending = subscribing.get(socket) ?? new Set<string>();
  subscribing.set(socket, pending);
  pending.add(room);
  try {
    await socket.join(spaceId ? [room, spaceOfRoom(spaceId)] : room);
    // A revocation committed during the check re-checked the sockets before this one joined.
    await recheckSockets([socket]);
  } finally {
    pending.delete(room);
  }
  if (!socket.rooms.has(room)) return notFound(target);
  return subscribed();
};

/** Whether the socket's principal takes part in the session, or is a member of the space. */
const joinedForAccess = async (
  socket: AppSocket,
  target: { sessionId: string } | { spaceId: string }
): Promise<boolean> => {
  const userId = socket.data.caller.principalId;
  if ("sessionId" in target) {
    const participant = await prisma.sessionParticipant.findFirst({
      where: { sessionId: target.sessionId, userId, leftAt: null },
      select: { userId: true },
    });
    return participant !== null;
  }
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: target.spaceId, userId } },
    select: { userId: true },
  });
  return member !== null;
};

const unsubscribe = async (
  socket: AppSocket,
  payload: unknown
): Promise<Ack> => {
  const { target, error } = parseTarget(payload);
  if (!target) return error;
  const room =
    "sessionId" in target
      ? sessionRoom(target.sessionId)
      : spaceRoom(target.spaceId);
  // Rooms joined for membership or participation are never left here.
  if (!socket.data.subscriptions.delete(room)) return OK;
  // Another node may have joined it for either since: it could not update this list.
  if (await joinedForAccess(socket, target)) return OK;
  await socket.leave(room);
  const spaceId =
    "sessionId" in target
      ? ((
          await prisma.session.findUnique({
            where: { id: target.sessionId },
            select: { spaceId: true },
          })
        )?.spaceId ?? null)
      : null;
  // A join that committed during the check found the socket still in the room.
  if (await joinedForAccess(socket, target)) {
    await socket.join(spaceId ? [room, spaceOfRoom(spaceId)] : room);
    // As in subscribe: a removal that committed meanwhile may have checked
    // this socket before it joined.
    await recheckSockets([socket]);
    return OK;
  }
  if (spaceId) await leaveSpaceOfIfUnused(socket, spaceId, room);
  return OK;
};

type Handler = (socket: AppSocket, payload: unknown) => Promise<Ack>;

const answer =
  (socket: AppSocket, event: string, handler: Handler) =>
  (payload: unknown, ack?: unknown) => {
    const reply = (value: Ack) => {
      if (typeof ack === "function") ack(value);
    };
    handler(socket, payload).then(reply, (err: unknown) => {
      logger.error(
        { err, event, principalId: socket.data.caller.principalId },
        "Socket event failed"
      );
      reply(failure(failureAck(err)));
    });
  };

/** `subscribe` and `unsubscribe`, each `{ sessionId }` or `{ spaceId }`. */
export const handleSubscriptions = (socket: AppSocket): void => {
  socket.on("subscribe", answer(socket, "subscribe", subscribe));
  socket.on("unsubscribe", answer(socket, "unsubscribe", unsubscribe));
  // Leaving every room on the way out is no loss to report.
  socket.on("disconnecting", () => socket.data.subscriptions.clear());
};

/**
 * Sends `unsubscribed` (`{ sessionId }` or `{ spaceId }`) to a socket of this node when it
 * leaves a room it holds by `subscribe` other than by `unsubscribe`: a re-check or a removal,
 * run by any node. The subscription is dropped from its list then, so it no longer counts.
 */
export const watchSubscriptionLoss = (io: IOServer): void => {
  const nsp = io.of("/");
  nsp.adapter.on("leave-room", (room: string, id: string) => {
    const socket = nsp.sockets.get(id);
    if (!socket?.data?.subscriptions?.delete(room)) return;
    // Its own subscribe answers `not_found` instead.
    if (subscribing.get(socket)?.has(room)) return;
    const sessionId = sessionIdOf(room);
    const spaceId = spaceIdOf(room);
    socket.emit("unsubscribed", sessionId ? { sessionId } : { spaceId });
  });
};
