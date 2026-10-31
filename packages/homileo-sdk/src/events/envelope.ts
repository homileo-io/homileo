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
