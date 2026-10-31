import { EVENT_TYPES, type EventType } from "./registry.js";
import { Id, Timestamp } from "../resources/common.js";
import { z } from "zod";

/** An event id: a bigint, so a decimal string. */
const EventId = z.string().regex(/^\d{1,20}$/);

const envelopeOf = <T extends EventType>(type: T) =>
  z.strictObject({
    id: EventId,
    type: z.literal(type),
    createdAt: Timestamp,
    organizationId: Id,
    spaceId: Id.nullable(),
    sessionId: Id.nullable(),
    actorId: Id,
    payload: EVENT_TYPES[type].payload,
  });

type EnvelopeSchema = ReturnType<typeof envelopeOf<EventType>>;

const options = (Object.keys(EVENT_TYPES) as EventType[]).map((type) =>
  envelopeOf(type)
) as [EnvelopeSchema, ...EnvelopeSchema[]];

/**
 * One event as sockets and `GET /v1/sync` deliver it: one variant per type in
 * `EVENT_TYPES`, each with that type's payload schema.
 */
export const EventEnvelopeSchema = z.discriminatedUnion("type", options);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const SyncResponseSchema = z.strictObject({
  events: z.array(EventEnvelopeSchema),
  /** The cursor to pass as `since` next. */
  next: z.string(),
  hasMore: z.boolean(),
});

export type SyncResponse = z.infer<typeof SyncResponseSchema>;

/**
 * The socket's `ready` event, sent once its rooms are joined. `until` is a
 * sync cursor to pass as `/sync`'s `until` while catching up.
 */
export const SocketReadySchema = z.strictObject({ until: z.string().min(1) });

export type SocketReady = z.infer<typeof SocketReadySchema>;

/** A `subscribe` ack: on success, `until` is for `/sync` as `ready`'s is. */
export const SubscribeAckSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), until: z.string().min(1) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      issues: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional(),
    }),
  }),
]);

export type SubscribeAck = z.infer<typeof SubscribeAckSchema>;
