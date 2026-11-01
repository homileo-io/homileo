// @module-tag unit
// @module-tag sync
import { SyncQuerySchema } from "../../../../routes/v1/sync/schemas.js";
import { encodeSyncCursor } from "../../../../realtime/syncCursor.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const ids = (n: number) => Array.from({ length: n }, () => uuidv7()).join(",");

describe("GET /v1/sync query", () => {
  it("defaults the limit to 100 and the id lists to empty", () => {
    expect(SyncQuerySchema.parse({})).toEqual({
      limit: 100,
      sessionIds: [],
      spaceIds: [],
    });
  });

  it.each([
    ["limit 0", { limit: "0" }],
    ["limit 501", { limit: "501" }],
    ["a fractional limit", { limit: "1.5" }],
    ["an empty since", { since: "" }],
    ["51 sessionIds", { sessionIds: ids(51) }],
    ["51 spaceIds", { spaceIds: ids(51) }],
    ["a sessionId that is not a UUID", { sessionIds: "abc" }],
    ["an empty spaceId in the list", { spaceIds: `${uuidv7()},` }],
    ["a repeated sessionIds parameter", { sessionIds: [uuidv7(), uuidv7()] }],
    ["an unknown key", { after: "1" }],
    ["an empty until", { until: "" }],
    ["an until that is not a cursor", { until: "not-a-cursor" }],
    [
      "an until from the future",
      {
        until: encodeSyncCursor({
          txId: 1n,
          id: 0n,
          at: new Date(Date.now() + 3_600_000),
        }),
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(SyncQuerySchema.safeParse(input).success).toBe(false);
  });

  it("accepts limit 500 and 50 ids of each", () => {
    const parsed = SyncQuerySchema.safeParse({
      since: "abc",
      limit: "500",
      sessionIds: ids(50),
      spaceIds: ids(50),
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.sessionIds).toHaveLength(50);
  });

  it("lower-cases the ids and drops repeats", () => {
    const id = uuidv7();

    const parsed = SyncQuerySchema.parse({
      sessionIds: `${id.toUpperCase()},${id}`,
    });

    expect(parsed.sessionIds).toEqual([id]);
  });

  it("decodes until into a position", () => {
    const at = new Date(1_700_000_000_000);
    const until = encodeSyncCursor({ txId: 9007199254740993n, id: 0n, at });

    const parsed = SyncQuerySchema.safeParse({ since: "abc", until });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.until).toEqual({ txId: 9007199254740993n, id: 0n, at });
  });
});
