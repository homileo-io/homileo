import { EVENT_EXAMPLES } from "./resourceFixtures.js";
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  webhookEventTypes,
  type EventType,
} from "../events/registry.js";

const PERSISTED = [
  "space.created",
  "space.updated",
  "space.archived",
  "space.member_added",
  "space.member_removed",
  "space.member_role_changed",
  "space.join_requested",
  "space.join_decided",
  "session.created",
  "session.updated",
  "session.archived",
  "session.participant_added",
  "session.participant_removed",
  "message.created",
  "message.edited",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "thread.updated",
  "read.updated",
  "space.access_revoked",
  "session.access_revoked",
];

const USER_CHANNEL = [
  "read.updated",
  "space.access_revoked",
  "session.access_revoked",
];

describe("event registry", () => {
  it("lists every persisted day-one event", () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual([...PERSISTED].sort());
  });

  it("marks read.updated and the access revocations as not webhooks", () => {
    const notWebhooks = Object.entries(EVENT_TYPES)
      .filter(([, def]) => !def.webhook)
      .map(([name]) => name);
    expect(notWebhooks.sort()).toEqual([...USER_CHANNEL].sort());
  });

  it("routes read.updated and revocations to the user channel, session-scoped events to session", () => {
    for (const [name, def] of Object.entries(EVENT_TYPES)) {
      const expected = USER_CHANNEL.includes(name)
        ? "user"
        : name.startsWith("space.")
          ? "space"
          : "session";
      expect(def.channel, name).toBe(expected);
    }
  });

  it("prefixes webhook types with homileo.", () => {
    const types = webhookEventTypes();
    expect(types).toContain("homileo.message.created");
    expect(types).not.toContain("homileo.read.updated");
    expect(types.every((t) => t.startsWith("homileo."))).toBe(true);
  });

  it("every event type has its own payload schema", () => {
    for (const [name, def] of Object.entries(EVENT_TYPES)) {
      expect(def.payload.safeParse({ any: "thing" }).success, name).toBe(false);
    }
  });

  it.each(Object.keys(EVENT_EXAMPLES))(
    "each payload parses its example and rejects {}: %s",
    (name) => {
      const def = EVENT_TYPES[name as EventType];
      expect(def.payload.safeParse(EVENT_EXAMPLES[name]).success).toBe(true);
      expect(def.payload.safeParse({}).success).toBe(false);
    }
  );

  it("has an example for every event type", () => {
    expect(Object.keys(EVENT_EXAMPLES).sort()).toEqual(
      Object.keys(EVENT_TYPES).sort()
    );
  });
});
