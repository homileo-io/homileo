import { z } from "zod";

export type EventChannel = "space" | "session" | "user";

export interface EventDefinition {
  /** Whose realtime channel the event is pushed to. */
  channel: EventChannel;
  /** Whether it leaves through tereo's webhooks as `homileo.<name>`. */
  webhook: boolean;
  payload: z.ZodType;
}

const payload = z.record(z.string(), z.unknown());

const def = (channel: EventChannel, webhook = true): EventDefinition => ({
  channel,
  webhook,
  payload,
});

export const EVENT_TYPES = {
  "space.created": def("space"),
  "space.updated": def("space"),
  "space.archived": def("space"),
  "space.member_added": def("space"),
  "space.member_removed": def("space"),
  "space.member_role_changed": def("space"),
  "space.join_requested": def("space"),
  "space.join_decided": def("space"),
  "session.created": def("session"),
  "session.updated": def("session"),
  "session.archived": def("session"),
  "session.participant_added": def("session"),
  "session.participant_removed": def("session"),
  "message.created": def("session"),
  "message.edited": def("session"),
  "message.deleted": def("session"),
  "reaction.added": def("session"),
  "reaction.removed": def("session"),
  "thread.updated": def("session"),
  "read.updated": def("user", false),
  "space.access_revoked": def("user", false),
  "session.access_revoked": def("user", false),
} as const satisfies Record<string, EventDefinition>;

export type EventType = keyof typeof EVENT_TYPES;

/** The names declared to tereo: `homileo.`-prefixed, webhook events only. */
export const webhookEventTypes = (): string[] =>
  (Object.keys(EVENT_TYPES) as EventType[])
    .filter((name) => EVENT_TYPES[name].webhook)
    .map((name) => `homileo.${name}`);
