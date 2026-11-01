import type { ChangeEvent } from "../utils/changes.js";
import type { EventEnvelope } from "@homileo-io/sdk";
import { iso } from "./common.js";

/** The envelope sockets and `/sync` deliver; also takes an `EventRow`, leaving its `txId` out. */
export const eventView = (e: ChangeEvent): EventEnvelope =>
  ({
    id: e.id.toString(),
    type: e.type,
    createdAt: iso(e.createdAt),
    organizationId: e.organizationId,
    spaceId: e.spaceId,
    sessionId: e.sessionId,
    actorId: e.actorId,
    payload: e.payload,
  }) as EventEnvelope;
