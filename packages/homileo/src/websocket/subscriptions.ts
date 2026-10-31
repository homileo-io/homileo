import { readableSession, readableSpace } from "../utils/access.js";
import { NotFoundError, issuesOf } from "../utils/errors.js";
import type { Ack, AckError, AppSocket } from "./types.js";
import { IdSchema } from "../utils/idSchema.js";
import { MAX_SUBSCRIPTIONS } from "./limits.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
import { z } from "zod";
import {
  sessionIdOf,
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
} from "../realtime/rooms.js";

export const SubscriptionTargetSchema = z.union([
  z.strictObject({ sessionId: IdSchema }),
  z.strictObject({ spaceId: IdSchema }),
]);

const OK: Ack = { ok: true };
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
  if (socket.rooms.has(room)) return OK;

  const { subscriptions } = socket.data;
  const atLimit = () => {
    // A room left by a re-check on another node is still listed here.
    for (const r of subscriptions)
      if (!socket.rooms.has(r)) subscriptions.delete(r);
    return subscriptions.size >= MAX_SUBSCRIPTIONS;
  };
  const tooMany = failure({
    code: "too_many_subscriptions",
    message: `At most ${MAX_SUBSCRIPTIONS} subscriptions per socket`,
  });
  if (atLimit()) return tooMany;

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
  if (socket.rooms.has(room)) return OK;
  if (atLimit()) return tooMany;
  subscriptions.add(room);
  await socket.join(spaceId ? [room, spaceOfRoom(spaceId)] : room);
  return OK;
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

  if ("sessionId" in target) {
    const session = await prisma.session.findUnique({
      where: { id: target.sessionId },
      select: { spaceId: true },
    });
    if (session?.spaceId) {
      const others = [...socket.rooms].flatMap((r) => {
        const id = sessionIdOf(r);
        return id ? [id] : [];
      });
      const remaining = await prisma.session.count({
        where: { id: { in: others }, spaceId: session.spaceId },
      });
      if (remaining === 0) await socket.leave(spaceOfRoom(session.spaceId));
    }
  }
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
      reply(
        failure({ code: "internal_error", message: "Something went wrong" })
      );
    });
  };

/** `subscribe` and `unsubscribe`, each `{ sessionId }` or `{ spaceId }`. */
export const handleSubscriptions = (socket: AppSocket): void => {
  socket.on("subscribe", answer(socket, "subscribe", subscribe));
  socket.on("unsubscribe", answer(socket, "unsubscribe", unsubscribe));
};
