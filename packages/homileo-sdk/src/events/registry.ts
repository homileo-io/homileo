import { Id, Timestamp } from "../resources/common.js";
import { z } from "zod";
import {
  JoinRequestSchema,
  MessageSchema,
  ParticipantSchema,
  SessionSchema,
  SpaceMemberSchema,
  SpaceRoleSchema,
  SpaceSchema,
} from "../resources/index.js";

export type EventChannel = "space" | "session" | "user";

export interface EventDefinition {
  /** Whose realtime channel the event is pushed to. */
  channel: EventChannel;
  /** Whether it leaves through tereo's webhooks as `homileo.<name>`. */
  webhook: boolean;
  payload: z.ZodType;
}

const def = (
  channel: EventChannel,
  payload: z.ZodType,
  webhook = true
): EventDefinition => ({ channel, webhook, payload });

const Space = z.strictObject({ space: SpaceSchema });
const Session = z.strictObject({ session: SessionSchema });
const Message = z.strictObject({ message: MessageSchema });
const Request = z.strictObject({ request: JoinRequestSchema });
const Reaction = z.strictObject({
  sessionId: Id,
  messageId: Id,
  principalId: Id,
  emoji: z.string(),
});

export const EVENT_TYPES = {
  "space.created": def("space", Space),
  "space.updated": def("space", Space),
  "space.archived": def("space", Space),
  "space.member_added": def(
    "space",
    z.strictObject({ spaceId: Id, member: SpaceMemberSchema })
  ),
  "space.member_removed": def(
    "space",
    z.strictObject({ spaceId: Id, principalId: Id })
  ),
  "space.member_role_changed": def(
    "space",
    z.strictObject({
      spaceId: Id,
      member: SpaceMemberSchema,
      previousRole: SpaceRoleSchema,
    })
  ),
  "space.join_requested": def("space", Request),
  "space.join_decided": def("space", Request),
  "session.created": def("session", Session),
  "session.updated": def("session", Session),
  "session.archived": def("session", Session),
  "session.participant_added": def(
    "session",
    z.strictObject({ sessionId: Id, participant: ParticipantSchema })
  ),
  "session.participant_removed": def(
    "session",
    z.strictObject({ sessionId: Id, principalId: Id })
  ),
  "message.created": def("session", Message),
  "message.edited": def("session", Message),
  "message.deleted": def("session", Message),
  "reaction.added": def("session", Reaction),
  "reaction.removed": def("session", Reaction),
  "thread.updated": def(
    "session",
    z.strictObject({
      sessionId: Id,
      rootId: Id,
      replyCount: z.number().int(),
      lastReplyAt: Timestamp.nullable(),
    })
  ),
  "read.updated": def(
    "user",
    z.strictObject({
      principalId: Id,
      sessionId: Id,
      threadRootId: Id.nullable(),
      lastReadSeq: z.number().int(),
    }),
    false
  ),
  "space.access_revoked": def(
    "user",
    z.strictObject({ principalId: Id, spaceId: Id }),
    false
  ),
  "session.access_revoked": def(
    "user",
    z.strictObject({ principalId: Id, sessionId: Id }),
    false
  ),
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENT_TYPES;

/** The names declared to tereo: `homileo.`-prefixed, webhook events only. */
export const webhookEventTypes = (): string[] =>
  (Object.keys(EVENT_TYPES) as EventType[])
    .filter((name) => EVENT_TYPES[name].webhook)
    .map((name) => `homileo.${name}`);
