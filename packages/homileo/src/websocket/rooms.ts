import type { AppRemoteSocket, AppSocket, IOServer } from "./types.js";
import { sessionFactsFor, spaceFactsFor } from "../utils/access.js";
import type { Space } from "../../prisma/generated/client/index.js";
import { canReadSession, canReadSpace } from "../policy/index.js";
import type { SpaceFacts, SpaceRole } from "../policy/index.js";
import type { Caller } from "../middleware/auth.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
import { runPool } from "./pool.js";
import {
  sessionIdOf,
  sessionRoom,
  spaceIdOf,
  spaceOfIdOf,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../realtime/rooms.js";

/** Facts of spaces for one caller, built once per space. */
const spaceFactsCache = (
  c: Caller,
  spaces: Map<string, Space>,
  roleOf: (spaceId: string) => SpaceRole | null
) => {
  const built = new Map<string, Promise<SpaceFacts>>();
  return (spaceId: string): Promise<SpaceFacts> | null => {
    const space = spaces.get(spaceId);
    if (!space) return null;
    let facts = built.get(spaceId);
    if (!facts) {
      facts = spaceFactsFor(c, space, roleOf(spaceId));
      built.set(spaceId, facts);
    }
    return facts;
  };
};

/**
 * The rooms a new socket of `c` starts in: its personal room, the rooms of its spaces and
 * those of the sessions it takes part in and can read, in its token's organization only.
 */
export const roomsOnConnect = async (c: Caller): Promise<string[]> => {
  const [memberships, participations] = await Promise.all([
    prisma.spaceMember.findMany({
      where: {
        userId: c.principalId,
        space: { organizationId: c.organizationId },
      },
      include: { space: true },
    }),
    prisma.sessionParticipant.findMany({
      where: {
        userId: c.principalId,
        leftAt: null,
        session: { organizationId: c.organizationId },
      },
      include: { session: { include: { space: true } } },
    }),
  ]);
  const roleOf = new Map(memberships.map((m) => [m.spaceId, m.role]));
  const spaces = new Map<string, Space>([
    ...memberships.map((m) => [m.spaceId, m.space] as const),
    ...participations.flatMap(({ session }) =>
      session.space ? [[session.space.id, session.space] as const] : []
    ),
  ]);
  const factsOf = spaceFactsCache(c, spaces, (id) => roleOf.get(id) ?? null);

  const rooms = [userRoom(c.organizationId, c.principalId)];
  for (const { spaceId } of memberships) {
    const facts = await factsOf(spaceId);
    if (facts && canReadSpace(c, facts)) rooms.push(spaceRoom(spaceId));
  }
  for (const participant of participations) {
    const { session } = participant;
    const spaceFacts = session.spaceId ? await factsOf(session.spaceId) : null;
    const facts = sessionFactsFor(session, spaceFacts, participant);
    if (!canReadSession(c, facts)) continue;
    rooms.push(sessionRoom(session.id));
    if (session.spaceId) rooms.push(spaceOfRoom(session.spaceId));
  }
  return [...new Set(rooms)];
};

/**
 * The spaces of the session rooms `socket` joined after `snapshot` was taken: they were
 * checked by whatever joined them, and keep their `spaceof:` room.
 */
const spacesJoinedSince = async (
  socket: AppSocket | AppRemoteSocket,
  snapshot: string[]
): Promise<string[]> => {
  const before = new Set(snapshot);
  const sessionIds = [...socket.rooms].flatMap((room) => {
    const id = before.has(room) ? null : sessionIdOf(room);
    return id ? [id] : [];
  });
  if (sessionIds.length === 0) return [];
  const rows = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { spaceId: true },
  });
  return rows.flatMap((r) => (r.spaceId ? [r.spaceId] : []));
};

/**
 * Re-checks each socket's `session:` and `space:` rooms with the socket's own caller, loading
 * the facts for all of them at once, and leaves those it can no longer read, with `spaceof:`
 * once no session room of that space remains. `joining` are judged as if the socket were
 * already in them, since a remote socket's join may still be in flight. Returns the rooms
 * left, by socket id.
 */
export const recheckSockets = async (
  sockets: (AppSocket | AppRemoteSocket)[],
  joining: string[] = []
): Promise<Map<string, string[]>> => {
  const left = new Map<string, string[]>();
  const targets = sockets.filter((s) => s.data?.caller);
  // Rooms joined while the facts load were checked by whatever joined them, and have no
  // facts loaded here: judging them would leave them.
  const roomsOf = new Map(
    targets.map((s) => [s.id, [...new Set([...s.rooms, ...joining])]])
  );
  const sessionIds = new Set<string>();
  const spaceIds = new Set<string>();
  for (const socket of targets) {
    for (const room of roomsOf.get(socket.id) ?? []) {
      const sessionId = sessionIdOf(room);
      if (sessionId) sessionIds.add(sessionId);
      const spaceId = spaceIdOf(room);
      if (spaceId) spaceIds.add(spaceId);
    }
  }
  if (sessionIds.size === 0 && spaceIds.size === 0) {
    for (const socket of targets) left.set(socket.id, []);
    return left;
  }

  const principalIds = [
    ...new Set(targets.map((s) => s.data.caller.principalId)),
  ];
  const sessions = await prisma.session.findMany({
    where: { id: { in: [...sessionIds] } },
  });
  for (const session of sessions) {
    if (session.spaceId) spaceIds.add(session.spaceId);
  }
  const [spaceRows, members, participants] = await Promise.all([
    prisma.space.findMany({ where: { id: { in: [...spaceIds] } } }),
    prisma.spaceMember.findMany({
      where: { spaceId: { in: [...spaceIds] }, userId: { in: principalIds } },
    }),
    prisma.sessionParticipant.findMany({
      where: {
        sessionId: { in: [...sessionIds] },
        userId: { in: principalIds },
        leftAt: null,
      },
    }),
  ]);
  const sessionOf = new Map(sessions.map((s) => [s.id, s]));
  const spaces = new Map(spaceRows.map((s) => [s.id, s]));
  const roleOf = new Map(
    members.map((m) => [`${m.spaceId}:${m.userId}`, m.role])
  );
  const participantOf = new Map(
    participants.map((p) => [`${p.sessionId}:${p.userId}`, p])
  );

  for (const socket of targets) {
    const c = socket.data.caller;
    const factsOf = spaceFactsCache(
      c,
      spaces,
      (id) => roleOf.get(`${id}:${c.principalId}`) ?? null
    );
    const leaving: string[] = [];
    // Spaces with a session room the socket keeps.
    const keptSpaces = new Set<string>();
    const rooms = roomsOf.get(socket.id) ?? [];
    for (const room of rooms) {
      const sessionId = sessionIdOf(room);
      if (sessionId) {
        const session = sessionOf.get(sessionId);
        const spaceFacts = session?.spaceId
          ? await factsOf(session.spaceId)
          : null;
        const readable =
          session !== undefined &&
          (session.spaceId === null || spaceFacts !== null) &&
          canReadSession(
            c,
            sessionFactsFor(
              session,
              spaceFacts,
              participantOf.get(`${session.id}:${c.principalId}`) ?? null
            )
          );
        if (!readable) leaving.push(room);
        else if (session.spaceId) keptSpaces.add(session.spaceId);
        continue;
      }
      const spaceId = spaceIdOf(room);
      if (spaceId) {
        const facts = await factsOf(spaceId);
        if (!facts || !canReadSpace(c, facts)) leaving.push(room);
      }
    }
    const dropping = rooms.filter((room) => {
      const spaceId = spaceOfIdOf(room);
      return spaceId !== null && !keptSpaces.has(spaceId);
    });
    if (dropping.length > 0) {
      for (const spaceId of await spacesJoinedSince(socket, rooms)) {
        keptSpaces.add(spaceId);
      }
    }
    for (const room of dropping) {
      if (!keptSpaces.has(spaceOfIdOf(room) ?? "")) leaving.push(room);
    }
    await leaveRooms(socket, leaving);
    left.set(socket.id, leaving);
  }
  return left;
};

/**
 * Leaves the socket's `session:` and `space:` rooms that neither `held` (a `roomsOnConnect`
 * load) nor a load taken after them returns, and no explicit subscription holds: a
 * participation or membership removed before the socket was in the room, whose removal never
 * left it. Any join was committed before the room was joined, so the later load shows it.
 */
export const leaveUnheldRooms = async (
  socket: AppSocket,
  held: string[]
): Promise<void> => {
  const keep = new Set(held);
  const candidates = [...socket.rooms].filter(
    (r) =>
      (sessionIdOf(r) !== null || spaceIdOf(r) !== null) &&
      !keep.has(r) &&
      !socket.data.subscriptions.has(r)
  );
  if (candidates.length === 0) return;
  const still = new Set(await roomsOnConnect(socket.data.caller));
  const leaving = candidates.filter(
    (r) => !still.has(r) && !socket.data.subscriptions.has(r)
  );
  await leaveRooms(socket, leaving);
  const sessionIds = leaving.flatMap((r) => sessionIdOf(r) ?? []);
  if (sessionIds.length === 0) return;
  const spaces = await prisma.session.findMany({
    where: { id: { in: sessionIds } },
    select: { spaceId: true },
    distinct: ["spaceId"],
  });
  for (const { spaceId } of spaces) {
    if (spaceId) await leaveSpaceOfIfUnused(socket, spaceId, "");
  }
};

/** `roomsOnConnect` loads in flight at once during a sweep. */
const SWEEP_CONCURRENCY = 10;

/**
 * The backstop for this node's sockets: joins each to the participation and membership rooms
 * it is missing (a join lost in Redis), drops the subscriptions those rooms now hold, leaves
 * those rooms it no longer holds (`leaveUnheldRooms`), then re-checks them all.
 */
export const sweepSockets = async (io: IOServer): Promise<void> => {
  const sockets = [...io.of("/").sockets.values()];
  const loads = new Map<Caller, Promise<string[]>>();
  const load = (c: Caller) => {
    let rooms = loads.get(c);
    if (!rooms) {
      rooms = roomsOnConnect(c);
      loads.set(c, rooms);
    }
    return rooms;
  };
  await runPool(sockets, SWEEP_CONCURRENCY, async (socket) => {
    const c = socket.data?.caller;
    if (!c) return;
    try {
      const rooms = await load(c);
      const held = new Set(rooms);
      for (const r of socket.data.subscriptions) {
        if (held.has(r)) socket.data.subscriptions.delete(r);
      }
      if (socket.disconnected) return;
      await leaveUnheldRooms(socket, rooms);
      const missing = rooms.filter((r) => !socket.rooms.has(r));
      if (missing.length === 0 || socket.disconnected) return;
      await socket.join(missing);
      // A removal committed since the load shows in this reload, or fans out after the join.
      const still = new Set(await roomsOnConnect(c));
      const gone = missing.filter((r) => !still.has(r));
      for (const r of gone) await socket.leave(r);
    } catch (err) {
      logger.error(
        { err, principalId: c.principalId },
        "Joining a socket's missing rooms failed"
      );
    }
  });
  await recheckSockets(sockets);
};

/**
 * The ids of `sockets` whose own caller can read the session now. A mention reaches only
 * these, as `/sync` judges a mention by the reader's own token.
 */
export const socketsReadingSession = async (
  sockets: (AppSocket | AppRemoteSocket)[],
  sessionId: string
): Promise<string[]> => {
  const targets = sockets.filter((s) => s.data?.caller);
  if (targets.length === 0) return [];
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return [];
  const principalIds = [
    ...new Set(targets.map((s) => s.data.caller.principalId)),
  ];
  const [space, members, participants] = await Promise.all([
    session.spaceId
      ? prisma.space.findUnique({ where: { id: session.spaceId } })
      : null,
    session.spaceId
      ? prisma.spaceMember.findMany({
          where: { spaceId: session.spaceId, userId: { in: principalIds } },
        })
      : [],
    prisma.sessionParticipant.findMany({
      where: { sessionId, userId: { in: principalIds }, leftAt: null },
    }),
  ]);
  if (session.spaceId && !space) return [];
  const roleOf = new Map(members.map((m) => [m.userId, m.role]));
  const participantOf = new Map(participants.map((p) => [p.userId, p]));
  const reading: string[] = [];
  for (const socket of targets) {
    const c = socket.data.caller;
    const spaceFacts = space
      ? await spaceFactsFor(c, space, roleOf.get(c.principalId) ?? null)
      : null;
    const facts = sessionFactsFor(
      session,
      spaceFacts,
      participantOf.get(c.principalId) ?? null
    );
    if (canReadSession(c, facts)) reading.push(socket.id);
  }
  return reading;
};

/**
 * Leaves `rooms`, explicit subscriptions included: the socket's own node drops those from its
 * list and tells it (`watchSubscriptionLoss`).
 */
export const leaveRooms = async (
  socket: AppSocket | AppRemoteSocket,
  rooms: string[]
): Promise<void> => {
  for (const room of rooms) await socket.leave(room);
};

/**
 * Leaves `spaceof:<spaceId>` unless the socket is still in a session room of that space,
 * `except` aside (a room it is leaving).
 */
export const leaveSpaceOfIfUnused = async (
  socket: AppSocket | AppRemoteSocket,
  spaceId: string,
  except: string
): Promise<void> => {
  const others = [...socket.rooms].flatMap((room) => {
    const id = room === except ? null : sessionIdOf(room);
    return id ? [id] : [];
  });
  const remaining =
    others.length === 0
      ? 0
      : await prisma.session.count({ where: { id: { in: others }, spaceId } });
  if (remaining === 0) await socket.leave(spaceOfRoom(spaceId));
};
