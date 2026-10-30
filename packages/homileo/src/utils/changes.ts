import { EVENT_TYPES, type EventType } from "@homileo-io/sdk";
import { issuesOf, ValidationError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import { getTereo } from "./tereo.js";
import { db } from "./db/index.js";

export interface ChangeInput<T extends EventType = EventType> {
  type: T;
  organizationId: string;
  spaceId?: string | null;
  sessionId?: string | null;
  /** A principal id. */
  actorId: string;
  /** Becomes tereo's `entityType` and `entityId`. */
  entity: { type: string; id: string };
  /** Parsed with the type's schema in the registry. */
  payload: unknown;
  /** `userId` is the tereo user the entry is attributed to. */
  audit?: {
    action: "CREATE" | "UPDATE" | "DELETE";
    userId: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ChangeEvent {
  id: bigint;
  createdAt: Date;
  type: EventType;
  organizationId: string;
  spaceId: string | null;
  sessionId: string | null;
  actorId: string;
  payload: unknown;
}

/**
 * Records a change in the caller's transaction: the `events` row, a tereo
 * webhook outbox row when the type leaves as a webhook, and an audit outbox
 * row when `audit` is given. All commit or none do. The caller publishes the
 * returned event to sockets after commit.
 */
export const recordChange = async (
  tx: Prisma.TransactionClient,
  change: ChangeInput
): Promise<ChangeEvent> => {
  const definition = EVENT_TYPES[change.type];
  const parsed = definition.payload.safeParse(change.payload);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid payload for ${change.type}`,
      issuesOf(parsed.error)
    );
  }
  const payload = parsed.data as Prisma.InputJsonValue;
  const spaceId = change.spaceId ?? null;
  const sessionId = change.sessionId ?? null;

  const row = await db.events.insert(tx, {
    type: change.type,
    organizationId: change.organizationId,
    spaceId,
    sessionId,
    actorId: change.actorId,
    payload,
  });

  const { outbox } = getTereo();
  if (definition.webhook) {
    await outbox.emit(tx, {
      organizationId: change.organizationId,
      eventType: `homileo.${change.type}`,
      entityType: change.entity.type,
      entityId: change.entity.id,
      data: { eventId: String(row.id), ...(payload as object) },
    });
  }
  if (change.audit) {
    await outbox.audit(tx, {
      ...change.audit,
      organizationId: change.organizationId,
      entityType: change.entity.type,
      entityId: change.entity.id,
    });
  }

  return {
    id: row.id,
    createdAt: row.createdAt,
    type: change.type,
    organizationId: row.organizationId,
    spaceId,
    sessionId,
    actorId: change.actorId,
    payload,
  };
};
