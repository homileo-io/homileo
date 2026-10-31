// @module-tag unit
// @module-tag events
import { EVENT_TYPES, type EventType } from "@homileo-io/sdk";
import type { ChangeEvent } from "../../utils/changes.js";
import { describe, expect, it } from "vitest";
import {
  eventAudience,
  isRelevantTo,
  type Audience,
  type ReaderFacts,
} from "../../realtime/audience.js";
import {
  sessionRoom,
  spaceOfRoom,
  spaceRoom,
  userRoom,
} from "../../realtime/rooms.js";

const ORG = "00000000-0000-7000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-7000-8000-0000000000a2";
const SPACE = "00000000-0000-7000-8000-0000000000b1";
const SESSION = "00000000-0000-7000-8000-0000000000c1";
const MESSAGE = "00000000-0000-7000-8000-0000000000d1";
const ME = "00000000-0000-7000-8000-0000000000e1";
const TARGET = "00000000-0000-7000-8000-0000000000e2";
const ACTOR = "00000000-0000-7000-8000-0000000000e3";
const MENTIONED = "00000000-0000-7000-8000-0000000000e4";

const event = (
  type: EventType,
  o: Partial<Omit<ChangeEvent, "type">> = {}
): ChangeEvent => ({
  id: 1n,
  createdAt: new Date("2026-10-31T12:00:00.000Z"),
  type,
  organizationId: ORG,
  spaceId: null,
  sessionId: null,
  actorId: ACTOR,
  payload: {},
  ...o,
});

const inSpace = { spaceId: SPACE };
const inSession = { sessionId: SESSION };
const inSpaceSession = { spaceId: SPACE, sessionId: SESSION };
const member = (principalId: string) => ({
  spaceId: SPACE,
  member: { spaceId: SPACE, principalId, role: "member" },
});
const request = (principalId: string) => ({
  request: { id: MESSAGE, spaceId: SPACE, principalId, status: "pending" },
});
const session = (access: "space" | "members", spaceId: string | null) => ({
  session: { id: SESSION, spaceId, access },
});
const message = { message: { id: MESSAGE, sessionId: SESSION } };
const reaction = {
  sessionId: SESSION,
  messageId: MESSAGE,
  principalId: TARGET,
  emoji: "👍",
};

const audience = (o: Partial<Audience>): Audience => ({
  rooms: [],
  recheck: [],
  join: [],
  ...o,
});

const SPACE_ROOM = spaceRoom(SPACE);
const SESSION_ROOM = sessionRoom(SESSION);
const TARGET_ROOM = userRoom(ORG, TARGET);
const MENTIONED_ROOM = userRoom(ORG, MENTIONED);

const TABLE: Array<[string, ChangeEvent, string[], Audience]> = [
  [
    "space.created",
    event("space.created", inSpace),
    [],
    audience({ rooms: [SPACE_ROOM] }),
  ],
  [
    "space.updated",
    event("space.updated", inSpace),
    [],
    audience({ rooms: [SPACE_ROOM] }),
  ],
  [
    "space.archived",
    event("space.archived", inSpace),
    [],
    audience({ rooms: [SPACE_ROOM] }),
  ],
  [
    "space.member_added joins the target to the space and tells them",
    event("space.member_added", { ...inSpace, payload: member(TARGET) }),
    [],
    audience({
      rooms: [SPACE_ROOM, TARGET_ROOM],
      join: [{ principalId: TARGET, room: SPACE_ROOM }],
    }),
  ],
  [
    "space.member_removed also goes to the removed member",
    event("space.member_removed", {
      ...inSpace,
      payload: { spaceId: SPACE, principalId: TARGET },
    }),
    [],
    audience({ rooms: [SPACE_ROOM, TARGET_ROOM] }),
  ],
  [
    "space.member_role_changed also goes to the member",
    event("space.member_role_changed", {
      ...inSpace,
      payload: { ...member(TARGET), previousRole: "owner" },
    }),
    [],
    audience({ rooms: [SPACE_ROOM, TARGET_ROOM] }),
  ],
  [
    "space.join_requested also goes to the requester",
    event("space.join_requested", { ...inSpace, payload: request(TARGET) }),
    [],
    audience({ rooms: [SPACE_ROOM, TARGET_ROOM] }),
  ],
  [
    "space.join_decided also goes to the requester",
    event("space.join_decided", { ...inSpace, payload: request(TARGET) }),
    [],
    audience({ rooms: [SPACE_ROOM, TARGET_ROOM] }),
  ],
  [
    "session.created in a space also goes to the space",
    event("session.created", {
      ...inSpaceSession,
      payload: session("space", SPACE),
    }),
    [],
    audience({ rooms: [SESSION_ROOM, SPACE_ROOM] }),
  ],
  [
    "session.created with no space",
    event("session.created", { ...inSession, payload: session("space", null) }),
    [],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "session.created of a members-only session stays out of the space",
    event("session.created", {
      ...inSpaceSession,
      payload: session("members", SPACE),
    }),
    [],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "session.updated in a space also goes to the space",
    event("session.updated", {
      ...inSpaceSession,
      payload: session("space", SPACE),
    }),
    [],
    audience({ rooms: [SESSION_ROOM, SPACE_ROOM] }),
  ],
  [
    "session.archived in a space also goes to the space",
    event("session.archived", {
      ...inSpaceSession,
      payload: session("space", SPACE),
    }),
    [],
    audience({ rooms: [SESSION_ROOM, SPACE_ROOM] }),
  ],
  [
    "session.participant_added joins the target to the session and spaceof",
    event("session.participant_added", {
      ...inSpaceSession,
      payload: {
        sessionId: SESSION,
        participant: { sessionId: SESSION, principalId: TARGET },
      },
    }),
    [],
    audience({
      rooms: [SESSION_ROOM, TARGET_ROOM],
      join: [
        { principalId: TARGET, room: SESSION_ROOM },
        { principalId: TARGET, room: spaceOfRoom(SPACE) },
      ],
    }),
  ],
  [
    "session.participant_added with no space joins the session only",
    event("session.participant_added", {
      ...inSession,
      payload: {
        sessionId: SESSION,
        participant: { sessionId: SESSION, principalId: TARGET },
      },
    }),
    [],
    audience({
      rooms: [SESSION_ROOM, TARGET_ROOM],
      join: [{ principalId: TARGET, room: SESSION_ROOM }],
    }),
  ],
  [
    "session.participant_removed also goes to the removed participant",
    event("session.participant_removed", {
      ...inSession,
      payload: { sessionId: SESSION, principalId: TARGET },
    }),
    [],
    audience({ rooms: [SESSION_ROOM, TARGET_ROOM] }),
  ],
  [
    "message.created goes to the session and the mentioned, never the space",
    event("message.created", { ...inSpaceSession, payload: message }),
    [MENTIONED],
    audience({ rooms: [SESSION_ROOM, MENTIONED_ROOM] }),
  ],
  [
    "message.edited goes to the mentioned too",
    event("message.edited", { ...inSession, payload: message }),
    [MENTIONED],
    audience({ rooms: [SESSION_ROOM, MENTIONED_ROOM] }),
  ],
  [
    "message.deleted goes to the session only",
    event("message.deleted", { ...inSession, payload: message }),
    [MENTIONED],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "reaction.added goes to the session, not the reactor's room",
    event("reaction.added", { ...inSession, payload: reaction }),
    [],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "reaction.removed goes to the session",
    event("reaction.removed", { ...inSession, payload: reaction }),
    [],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "thread.updated goes to the session",
    event("thread.updated", {
      ...inSession,
      payload: { sessionId: SESSION, rootId: MESSAGE },
    }),
    [],
    audience({ rooms: [SESSION_ROOM] }),
  ],
  [
    "read.updated goes to the target's personal room only",
    event("read.updated", {
      ...inSpaceSession,
      payload: { principalId: TARGET, sessionId: SESSION },
    }),
    [],
    audience({ rooms: [TARGET_ROOM] }),
  ],
  [
    "session.access_revoked is re-checked, in no room",
    event("session.access_revoked", {
      ...inSpaceSession,
      payload: { principalId: TARGET, sessionId: SESSION },
    }),
    [],
    audience({ recheck: [TARGET] }),
  ],
  [
    "space.access_revoked is re-checked, in no room",
    event("space.access_revoked", {
      ...inSpace,
      payload: { principalId: TARGET, spaceId: SPACE },
    }),
    [],
    audience({ recheck: [TARGET] }),
  ],
];

describe("eventAudience", () => {
  it("has a row for every registry type", () => {
    const covered = new Set(TABLE.map(([, e]) => e.type));

    expect([...covered].sort()).toEqual(Object.keys(EVENT_TYPES).sort());
  });

  it.each(TABLE)("%s", (_name, e, mentioned, expected) => {
    const actual = eventAudience(e, mentioned);

    expect(actual.rooms.sort()).toEqual([...expected.rooms].sort());
    expect(actual.recheck).toEqual(expected.recheck);
    expect(actual.join).toEqual(expected.join);
  });

  it("names each room once", () => {
    const e = event("message.created", { ...inSession, payload: message });

    const { rooms } = eventAudience(e, [MENTIONED, MENTIONED]);

    expect(rooms.sort()).toEqual([SESSION_ROOM, MENTIONED_ROOM].sort());
  });

  it("puts personal rooms in the event's organization", () => {
    const e = event("read.updated", {
      organizationId: OTHER_ORG,
      ...inSession,
      payload: { principalId: TARGET, sessionId: SESSION },
    });

    expect(eventAudience(e, []).rooms).toEqual([userRoom(OTHER_ORG, TARGET)]);
  });
});

const reader = (o: Partial<ReaderFacts> = {}): ReaderFacts => ({
  principalId: ME,
  organizationId: ORG,
  participantOf: new Set(),
  memberOf: new Set(),
  watchedSessions: new Set(),
  watchedSpaces: new Set(),
  mentionedIn: new Set(),
  canReadSession: () => true,
  canReadSpace: () => true,
  ...o,
});

const messageEvent = event("message.created", {
  ...inSpaceSession,
  payload: message,
});
const spaceEvent = event("space.updated", inSpace);

describe("isRelevantTo", () => {
  describe("session events", () => {
    it("reach a current participant", () => {
      expect(
        isRelevantTo(
          messageEvent,
          reader({ participantOf: new Set([SESSION]) })
        )
      ).toBe(true);
    });

    it("do not reach a non-participant, even a member of the space", () => {
      expect(
        isRelevantTo(messageEvent, reader({ memberOf: new Set([SPACE]) }))
      ).toBe(false);
    });

    it("reach a reader watching the session", () => {
      expect(
        isRelevantTo(
          messageEvent,
          reader({ watchedSessions: new Set([SESSION]) })
        )
      ).toBe(true);
    });

    it("reach a reader the message mentions", () => {
      expect(
        isRelevantTo(messageEvent, reader({ mentionedIn: new Set([MESSAGE]) }))
      ).toBe(true);
    });

    it("never reach a reader who cannot read the session", () => {
      const r = reader({
        participantOf: new Set([SESSION]),
        watchedSessions: new Set([SESSION]),
        canReadSession: () => false,
      });

      expect(isRelevantTo(messageEvent, r)).toBe(false);
    });

    it("lifecycle events of a space-access session reach the space's members", () => {
      const e = event("session.created", {
        ...inSpaceSession,
        payload: session("space", SPACE),
      });

      expect(isRelevantTo(e, reader({ memberOf: new Set([SPACE]) }))).toBe(
        true
      );
      expect(isRelevantTo(e, reader({ watchedSpaces: new Set([SPACE]) }))).toBe(
        true
      );
      expect(isRelevantTo(e, reader())).toBe(false);
    });

    it("lifecycle events of a members-only session stay with its participants", () => {
      const e = event("session.updated", {
        ...inSpaceSession,
        payload: session("members", SPACE),
      });

      expect(isRelevantTo(e, reader({ memberOf: new Set([SPACE]) }))).toBe(
        false
      );
    });

    it("participant events reach the participant they name", () => {
      const e = event("session.participant_removed", {
        ...inSession,
        payload: { sessionId: SESSION, principalId: ME },
      });

      expect(isRelevantTo(e, reader())).toBe(true);
    });
  });

  describe("space events", () => {
    it("reach a member", () => {
      expect(
        isRelevantTo(spaceEvent, reader({ memberOf: new Set([SPACE]) }))
      ).toBe(true);
    });

    it("do not reach a non-member unless the space is watched", () => {
      expect(isRelevantTo(spaceEvent, reader())).toBe(false);
      expect(
        isRelevantTo(spaceEvent, reader({ watchedSpaces: new Set([SPACE]) }))
      ).toBe(true);
    });

    it("never reach a reader who cannot read the space", () => {
      const r = reader({
        memberOf: new Set([SPACE]),
        canReadSpace: () => false,
      });

      expect(isRelevantTo(spaceEvent, r)).toBe(false);
    });

    it("member events reach the member they name", () => {
      const e = event("space.join_decided", {
        ...inSpace,
        payload: request(ME),
      });

      expect(isRelevantTo(e, reader())).toBe(true);
    });
  });

  describe("personal events", () => {
    const read = (principalId: string) =>
      event("read.updated", {
        ...inSession,
        payload: { principalId, sessionId: SESSION },
      });

    it("reach their target", () => {
      expect(isRelevantTo(read(ME), reader())).toBe(true);
    });

    it("never reach another principal, even a participant", () => {
      const r = reader({ participantOf: new Set([SESSION]) });

      expect(isRelevantTo(read(TARGET), r)).toBe(false);
    });

    it("never reach a target who cannot read the session", () => {
      expect(
        isRelevantTo(read(ME), reader({ canReadSession: () => false }))
      ).toBe(false);
    });
  });

  describe("revocations", () => {
    const sessionRevoked = event("session.access_revoked", {
      ...inSession,
      payload: { principalId: ME, sessionId: SESSION },
    });
    const spaceRevoked = event("space.access_revoked", {
      ...inSpace,
      payload: { principalId: ME, spaceId: SPACE },
    });

    it("reach a target who really lost access", () => {
      const r = reader({
        canReadSession: () => false,
        canReadSpace: () => false,
      });

      expect(isRelevantTo(sessionRevoked, r)).toBe(true);
      expect(isRelevantTo(spaceRevoked, r)).toBe(true);
    });

    it("are dropped while the target can still read the resource", () => {
      expect(isRelevantTo(sessionRevoked, reader())).toBe(false);
      expect(isRelevantTo(spaceRevoked, reader())).toBe(false);
    });

    it("never reach anyone but the target", () => {
      const r = reader({
        principalId: TARGET,
        canReadSession: () => false,
        canReadSpace: () => false,
      });

      expect(isRelevantTo(sessionRevoked, r)).toBe(false);
    });
  });

  it("never reaches a reader in another organization", () => {
    const r = reader({
      organizationId: OTHER_ORG,
      participantOf: new Set([SESSION]),
    });

    expect(isRelevantTo(messageEvent, r)).toBe(false);
  });
});
