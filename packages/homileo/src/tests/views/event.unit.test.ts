// @module-tag unit
// @module-tag events
import { at, id, spaceRow } from "../support/pure/viewRows.js";
import { EventEnvelopeSchema } from "@homileo-io/sdk";
import { spaceView } from "../../views/space.js";
import { eventView } from "../../views/event.js";
import { describe, expect, it } from "vitest";

const payload = { space: spaceView(spaceRow) };

describe("eventView", () => {
  it("writes the id as a decimal string, createdAt as ISO and the payload as stored", () => {
    const view = eventView({
      id: 9007199254740993n,
      createdAt: at,
      type: "space.updated",
      organizationId: spaceRow.organizationId,
      spaceId: spaceRow.id,
      sessionId: null,
      actorId: id(1),
      payload,
    });

    expect(view).toEqual({
      id: "9007199254740993",
      type: "space.updated",
      createdAt: "2026-10-30T12:00:00.000Z",
      organizationId: spaceRow.organizationId,
      spaceId: spaceRow.id,
      sessionId: null,
      actorId: id(1),
      payload,
    });
    expect(EventEnvelopeSchema.safeParse(view).success).toBe(true);
  });

  it("leaves an event row's txId out", () => {
    const view = eventView(
      Object.assign(
        {
          id: 1n,
          createdAt: at,
          type: "space.updated" as const,
          organizationId: spaceRow.organizationId,
          spaceId: spaceRow.id,
          sessionId: null,
          actorId: id(1),
          payload,
        },
        { txId: 5n }
      )
    );

    expect(view).not.toHaveProperty("txId");
  });
});
