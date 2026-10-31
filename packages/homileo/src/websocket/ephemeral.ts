import { expire, goOffline, heartbeat, statuses } from "../utils/presence.js";
import { presenceRoom, sessionRoom, userRoom } from "../realtime/rooms.js";
import type { Ack, AckError, AppSocket, IOServer } from "./types.js";
import { NotFoundError, issuesOf } from "../utils/errors.js";
import { readableSession } from "../utils/access.js";
import { IdSchema } from "../utils/idSchema.js";
import { canPost } from "../policy/index.js";
import { logger } from "../utils/logger.js";
import { MAX_WATCHED } from "./limits.js";
import { z } from "zod";

/** How long a client shows a typing signal before it must be refreshed. */
export const TYPING_EXPIRES_MS = 6000;
const TYPING_THROTTLE_MS = 2000;
const PRESENCE_SWEEP_MS = 30_000;

const OK: Ack = { ok: true };
const failure = (error: AckError): Ack => ({ ok: false, error });

const announce = (
  nsp: Pick<IOServer, "to">,
  org: string,
  principalId: string,
  status: "online" | "offline"
) => {
  nsp
    .to(presenceRoom(org, principalId))
    .emit("presence", { principalId, status });
};

const TypingSchema = z.strictObject({ sessionId: IdSchema });

const typing =
  (socket: AppSocket, lastStart: Map<string, number>, isTyping: boolean) =>
  async (payload: unknown): Promise<Ack> => {
    const parsed = TypingSchema.safeParse(payload);
    if (!parsed.success) {
      return failure({
        code: "invalid_request",
        message: "Expected { sessionId }",
        issues: issuesOf(parsed.error),
      });
    }
    const { sessionId } = parsed.data;
    const { caller } = socket.data;
    try {
      const { facts } = await readableSession(caller, sessionId);
      // Not being allowed to post answers like not being able to read: nothing leaks.
      if (!canPost(caller, facts)) throw new NotFoundError("Session not found");
    } catch (err) {
      if (err instanceof NotFoundError) {
        return failure({ code: "not_found", message: "Session not found" });
      }
      throw err;
    }
    if (isTyping) {
      const now = Date.now();
      for (const [id, at] of lastStart)
        if (now - at >= TYPING_THROTTLE_MS) lastStart.delete(id);
      if (lastStart.has(sessionId)) return OK;
      lastStart.set(sessionId, now);
    }
    socket.to(sessionRoom(sessionId)).emit("typing", {
      sessionId,
      principalId: caller.principalId,
      typing: isTyping,
      expiresInMs: TYPING_EXPIRES_MS,
    });
    return OK;
  };

const WatchSchema = z.strictObject({ principalIds: z.array(IdSchema) });

const tooManyWatched = () =>
  failure({
    code: "too_many_watched",
    message: `At most ${MAX_WATCHED} watched principals per socket`,
  });

const watch = async (socket: AppSocket, payload: unknown): Promise<Ack> => {
  // Before the schema, so an oversized list is told apart from a malformed one.
  const listed = (payload as { principalIds?: unknown } | null | undefined)
    ?.principalIds;
  if (Array.isArray(listed) && listed.length > MAX_WATCHED) {
    return tooManyWatched();
  }
  const parsed = WatchSchema.safeParse(payload);
  if (!parsed.success) {
    return failure({
      code: "invalid_request",
      message: "Expected { principalIds: string[] }",
      issues: issuesOf(parsed.error),
    });
  }
  const ids = new Set(parsed.data.principalIds);
  if (ids.size > MAX_WATCHED) return tooManyWatched();

  const { organizationId } = socket.data.caller;
  const leaving = [...socket.data.watched].filter((id) => !ids.has(id));
  socket.data.watched = ids;
  await Promise.all(
    leaving.map((id) => socket.leave(presenceRoom(organizationId, id)))
  );
  await socket.join([...ids].map((id) => presenceRoom(organizationId, id)));
  return { ok: true, statuses: await statuses(organizationId, [...ids]) };
};

const beat = async (socket: AppSocket): Promise<void> => {
  const { organizationId, principalId } = socket.data.caller;
  if (await heartbeat(organizationId, principalId)) {
    announce(socket.nsp, organizationId, principalId, "online");
  }
};

const leave = async (socket: AppSocket): Promise<void> => {
  const { organizationId, principalId } = socket.data.caller;
  // The socket has left its rooms by now, on this node and so in the answer from every node.
  const remaining = await socket.nsp
    .in(userRoom(organizationId, principalId))
    .fetchSockets();
  if (remaining.length > 0) return;
  if (await goOffline(organizationId, principalId)) {
    announce(socket.nsp, organizationId, principalId, "offline");
  }
};

const logFailure = (socket: AppSocket, event: string) => (err: unknown) => {
  logger.error(
    { err, event, principalId: socket.data.caller.principalId },
    "Socket event failed"
  );
};

/** Typing and presence: ephemeral signals that are never stored. */
export const handleEphemeral = (socket: AppSocket): void => {
  const lastStart = new Map<string, number>();
  const answer =
    (event: string, handler: (payload: unknown) => Promise<Ack>) =>
    (payload: unknown, ack?: unknown) => {
      const reply = (value: Ack) => {
        if (typeof ack === "function") ack(value);
      };
      handler(payload).then(reply, (err: unknown) => {
        logFailure(socket, event)(err);
        reply(
          failure({ code: "internal_error", message: "Something went wrong" })
        );
      });
    };

  socket.on(
    "typing.start",
    answer("typing.start", typing(socket, lastStart, true))
  );
  socket.on(
    "typing.stop",
    answer("typing.stop", typing(socket, lastStart, false))
  );
  socket.on(
    "presence.heartbeat",
    answer("presence.heartbeat", async () => {
      await beat(socket);
      return OK;
    })
  );
  socket.on(
    "presence.watch",
    answer("presence.watch", (payload) => watch(socket, payload))
  );
  socket.on("disconnect", () => {
    leave(socket).catch(logFailure(socket, "disconnect"));
  });
  // Connecting is a heartbeat.
  beat(socket).catch(logFailure(socket, "connect"));
};

/** Removes the expired entries and tells each one's watchers; returns who went offline. */
export const sweepPresence = async (
  io: Pick<IOServer, "to">,
  org?: string,
  now?: number
) => {
  const removed = await expire(org, now);
  for (const { org: o, principalId } of removed) {
    announce(io, o, principalId, "offline");
  }
  return removed;
};

/** Sweeps every 30 s until the returned function is called. */
export const startPresenceSweep = (io: IOServer): (() => void) => {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepPresence(io)
      .catch((err: unknown) => {
        logger.error({ err }, "Presence sweep failed");
      })
      .finally(() => {
        running = false;
      });
  }, PRESENCE_SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
};
