import { sessionRoom, spaceOfRoom, spaceRoom, userRoom } from "./rooms.js";
import { EVENT_TYPES, type EventType } from "@homileo-io/sdk";
import type { ChangeEvent } from "../utils/changes.js";

export interface Audience {
  /** Rooms the event goes to. */
  rooms: string[];
  /** Personal-room targets that must first be re-checked (revocations). */
  recheck: string[];
  /** Sockets of these principals join `room` before the emit. */
  join: Array<{ principalId: string; room: string }>;
}

/** What `isRelevantTo` knows of one reader, loaded in bulk by its caller. */
export interface ReaderFacts {
  principalId: string;
  organizationId: string;
  /** Session ids the reader currently takes part in. */
  participantOf: Set<string>;
  /** Space ids the reader is a member of. */
  memberOf: Set<string>;
  watchedSessions: Set<string>;
  watchedSpaces: Set<string>;
  /** Message ids whose mentions name the reader. */
  mentionedIn: Set<string>;
  canReadSession(id: string): boolean;
  canReadSpace(id: string): boolean;
}

/**
 * Where in the payload each event names the principal it is about. Those
 * events also reach that principal, member or not.
 */
export const TARGET_PATHS: Partial<Record<EventType, readonly string[]>> = {
  "space.member_added": ["member", "principalId"],
  "space.member_role_changed": ["member", "principalId"],
  "space.member_removed": ["principalId"],
  "space.join_requested": ["request", "principalId"],
  "space.join_decided": ["request", "principalId"],
  "session.participant_added": ["participant", "principalId"],
  "session.participant_removed": ["principalId"],
  "read.updated": ["principalId"],
  "space.access_revoked": ["principalId"],
  "session.access_revoked": ["principalId"],
};

/** Session events that a space-access session's space also hears. */
export const SPACE_SESSION_EVENTS: readonly EventType[] = [
  "session.created",
  "session.updated",
  "session.archived",
];

/** Events the mentioned principals also get. */
export const MENTION_EVENTS: readonly EventType[] = [
  "message.created",
  "message.edited",
];

const REVOCATIONS: readonly EventType[] = [
  "session.access_revoked",
  "space.access_revoked",
];

const field = (value: unknown, path: readonly string[]): string | null => {
  let at = value;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return null;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === "string" ? at : null;
};

export const targetOf = (e: ChangeEvent): string | null => {
  const path = TARGET_PATHS[e.type];
  return path ? field(e.payload, path) : null;
};

/** The message a mention event is about, else `null`. */
export const mentionedMessageOf = (e: ChangeEvent): string | null =>
  MENTION_EVENTS.includes(e.type) ? field(e.payload, ["message", "id"]) : null;

/** The space whose audience also hears this session event, if any. */
const audienceSpaceOf = (e: ChangeEvent): string | null =>
  e.spaceId &&
  SPACE_SESSION_EVENTS.includes(e.type) &&
  field(e.payload, ["session", "access"]) === "space"
    ? e.spaceId
    : null;

/**
 * Who receives a committed event, as rooms. `mentioned` are the principals a
 * message event mentions who may read its session. Revocations go to no room:
 * each target's sockets are re-checked and told one by one.
 */
export const eventAudience = (
  e: ChangeEvent,
  mentioned: string[]
): Audience => {
  const target = targetOf(e);
  if (REVOCATIONS.includes(e.type)) {
    return { rooms: [], recheck: target ? [target] : [], join: [] };
  }
  const rooms: string[] = [];
  const join: Audience["join"] = [];
  const { channel } = EVENT_TYPES[e.type];

  if (channel === "space" && e.spaceId) {
    rooms.push(spaceRoom(e.spaceId));
    if (e.type === "space.member_added" && target) {
      join.push({ principalId: target, room: spaceRoom(e.spaceId) });
    }
  }
  if (channel === "session" && e.sessionId) {
    rooms.push(sessionRoom(e.sessionId));
    const spaceId = audienceSpaceOf(e);
    if (spaceId) rooms.push(spaceRoom(spaceId));
    if (e.type === "session.participant_added" && target) {
      join.push({ principalId: target, room: sessionRoom(e.sessionId) });
      if (e.spaceId) {
        join.push({ principalId: target, room: spaceOfRoom(e.spaceId) });
      }
    }
    if (MENTION_EVENTS.includes(e.type)) {
      for (const p of mentioned) rooms.push(userRoom(e.organizationId, p));
    }
  }
  if (target) rooms.push(userRoom(e.organizationId, target));
  return { rooms: [...new Set(rooms)], recheck: [], join };
};

/**
 * Whether `/sync` returns the event to this reader: the same readers
 * `eventAudience` reaches, judged by what they can read now.
 */
export const isRelevantTo = (e: ChangeEvent, r: ReaderFacts): boolean => {
  if (e.organizationId !== r.organizationId) return false;
  const target = targetOf(e);
  const { channel } = EVENT_TYPES[e.type];

  if (channel === "user") {
    if (target !== r.principalId) return false;
    // A revocation tells the reader what they can no longer read.
    if (e.type === "session.access_revoked") {
      const sessionId = field(e.payload, ["sessionId"]);
      return sessionId !== null && !r.canReadSession(sessionId);
    }
    if (e.type === "space.access_revoked") {
      const spaceId = field(e.payload, ["spaceId"]);
      return spaceId !== null && !r.canReadSpace(spaceId);
    }
    return e.sessionId !== null && r.canReadSession(e.sessionId);
  }

  if (channel === "space") {
    const spaceId = e.spaceId;
    if (!spaceId || !r.canReadSpace(spaceId)) return false;
    return (
      target === r.principalId ||
      r.memberOf.has(spaceId) ||
      r.watchedSpaces.has(spaceId)
    );
  }

  const sessionId = e.sessionId;
  if (!sessionId || !r.canReadSession(sessionId)) return false;
  if (
    target === r.principalId ||
    r.participantOf.has(sessionId) ||
    r.watchedSessions.has(sessionId)
  ) {
    return true;
  }
  const spaceId = audienceSpaceOf(e);
  if (spaceId && (r.memberOf.has(spaceId) || r.watchedSpaces.has(spaceId))) {
    return true;
  }
  const messageId = mentionedMessageOf(e);
  return messageId !== null && r.mentionedIn.has(messageId);
};
