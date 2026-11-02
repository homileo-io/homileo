import { EVENT_TYPES, webhookEventName, type EventType } from "@homileo-io/sdk";
import { isPrivateSession } from "../policy/index.js";
import type { Prisma } from "./db/prisma.js";
import { issuesOf } from "./errors.js";
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
 * webhook outbox row when the type leaves as a webhook (under its private name
 * for a private session, `webhookEventName`), and an audit outbox
 * row when `audit` is given. All commit or none do. The caller publishes the
 * returned event to sockets after commit.
 */
export const recordChange = async (
  tx: Prisma.TransactionClient,
  change: ChangeInput
): Promise<ChangeEvent> => (await recordChanges(tx, [change]))[0];

/**
 * `recordChange` for many changes in a fixed number of statements, however
 * many there are. Event ids and outbox rows follow the order given.
 */
export const recordChanges = async (
  tx: Prisma.TransactionClient,
  changes: ChangeInput[]
): Promise<ChangeEvent[]> => {
  if (changes.length === 0) return [];
  const inputs = changes.map((change) => {
    const parsed = EVENT_TYPES[change.type].payload.safeParse(change.payload);
    // The server built the payload, so a mismatch is its bug: a 500, not a 400.
    if (!parsed.success) {
      throw new Error(
        `Built an invalid ${change.type} payload: ${JSON.stringify(issuesOf(parsed.error))}`
      );
    }
    return {
      type: change.type,
      organizationId: change.organizationId,
      spaceId: change.spaceId ?? null,
      sessionId: change.sessionId ?? null,
      actorId: change.actorId,
      payload: parsed.data as Prisma.InputJsonValue,
    };
  });

  const rows = await db.events.insertMany(tx, inputs);

  const webhookSessionIds = new Set<string>();
  for (const input of inputs) {
    const definition = EVENT_TYPES[input.type];
    if (definition.webhook && definition.channel === "session") {
      if (input.sessionId !== null) webhookSessionIds.add(input.sessionId);
    }
  }
  const access =
    webhookSessionIds.size > 0
      ? await db.sessions.accessOfMany(tx, [...webhookSessionIds])
      : new Map<string, never>();

  const { outbox } = getTereo();
  const pending = db.outbox.collector();
  for (const [i, change] of changes.entries()) {
    const input = inputs[i];
    const definition = EVENT_TYPES[input.type];
    if (definition.webhook) {
      let privateSession = false;
      if (definition.channel === "session" && input.sessionId !== null) {
        const session = access.get(input.sessionId);
        privateSession = session === undefined || isPrivateSession(session);
      }
      await outbox.emit(pending.client, {
        organizationId: input.organizationId,
        eventType: webhookEventName(input.type, { privateSession }),
        entityType: change.entity.type,
        entityId: change.entity.id,
        data: { ...(input.payload as object), eventId: String(rows[i].id) },
      });
    }
    if (change.audit) {
      await outbox.audit(pending.client, {
        ...change.audit,
        organizationId: input.organizationId,
        entityType: change.entity.type,
        entityId: change.entity.id,
      });
    }
  }
  await pending.flush(tx);

  return inputs.map((input, i) => ({ ...input, ...rows[i] }));
};
