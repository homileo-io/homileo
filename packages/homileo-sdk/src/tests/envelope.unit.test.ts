import { EventEnvelopeSchema, SyncResponseSchema } from "../events/envelope.js";
import { EVENT_TYPES, type EventType } from "../events/registry.js";
import { describe, expect, it } from "vitest";
import * as fx from "./resourceFixtures.js";

const envelope = (
  type: string,
  payload: unknown = fx.EVENT_EXAMPLES[type]
) => ({
  id: "9007199254740993",
  type,
  createdAt: "2026-10-31T12:00:00.000Z",
  organizationId: fx.space.organizationId,
  spaceId: fx.space.id,
  sessionId: null,
  actorId: fx.principal.id,
  payload,
});

describe("EventEnvelopeSchema", () => {
  it.each(Object.keys(EVENT_TYPES) as EventType[])(
    "accepts a %s envelope with that type's payload",
    (type) => {
      const parsed = EventEnvelopeSchema.safeParse(envelope(type));

      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  );

  it("checks the payload against the schema of its own type", () => {
    const parsed = EventEnvelopeSchema.safeParse(
      envelope("message.created", fx.EVENT_EXAMPLES["space.created"])
    );

    expect(parsed.success).toBe(false);
  });

  it("refuses a type the registry does not list", () => {
    const parsed = EventEnvelopeSchema.safeParse(
      envelope("message.exploded", fx.EVENT_EXAMPLES["message.created"])
    );

    expect(parsed.success).toBe(false);
  });

  it.each([
    ["a number", 12],
    ["a negative string", "-1"],
    ["a non-decimal string", "0x1f"],
  ])("refuses an id that is %s", (_name, id) => {
    const parsed = EventEnvelopeSchema.safeParse({
      ...envelope("space.created"),
      id,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a field the envelope does not have", () => {
    const parsed = EventEnvelopeSchema.safeParse({
      ...envelope("space.created"),
      txId: "5",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("SyncResponseSchema", () => {
  it("accepts events, the next cursor and hasMore", () => {
    const parsed = SyncResponseSchema.safeParse({
      events: [envelope("space.created"), envelope("read.updated")],
      next: "WyI1IiwiMCIsMTc2MTkxMjAwMDAwMF0",
      hasMore: false,
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("requires hasMore", () => {
    const parsed = SyncResponseSchema.safeParse({ events: [], next: "x" });

    expect(parsed.success).toBe(false);
  });
});
