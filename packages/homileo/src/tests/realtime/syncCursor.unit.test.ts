// @module-tag unit
// @module-tag events
import { ValidationError } from "../../utils/errors.js";
import { encodeCursor } from "../../utils/cursor.js";
import { describe, expect, it } from "vitest";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  tooOldToSync,
} from "../../realtime/syncCursor.js";

describe("sync cursor", () => {
  it("round trips a position, bigints beyond 2^53 included", () => {
    const position = {
      txId: 9007199254740993n,
      id: 123456789012345678n,
      at: new Date(1_700_000_000_123),
    };

    const decoded = decodeSyncCursor(encodeSyncCursor(position));

    expect(decoded).toEqual(position);
  });

  it("writes base64url JSON of [txId, id, at] with decimal strings", () => {
    const cursor = encodeSyncCursor({
      txId: 5n,
      id: 0n,
      at: new Date(1_800_000_000_000),
    });

    expect(JSON.parse(Buffer.from(cursor, "base64url").toString())).toEqual([
      "5",
      "0",
      1_800_000_000_000,
    ]);
  });

  it.each([
    ["not base64url", "***"],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["the wrong arity", encodeCursor(["1", "2"])],
    ["a numeric txId", encodeCursor([1, "2", 1_700_000_000_000])],
    ["a non-decimal id", encodeCursor(["1", "x", 1_700_000_000_000])],
    ["a negative id", encodeCursor(["1", "-2", 1_700_000_000_000])],
    ["a string at", encodeCursor(["1", "2", "1700000000000"])],
    ["a fractional at", encodeCursor(["1", "2", 1.5])],
    ["an id past 2^64", encodeCursor(["1", "18446744073709551616", 1])],
  ])("rejects %s", (_name, cursor) => {
    expect(() => decodeSyncCursor(cursor)).toThrow(ValidationError);
    expect(() => decodeSyncCursor(cursor)).toThrow("Invalid cursor");
  });

  it("rejects an at an hour ahead and accepts one within the clock skew allowance", () => {
    const future = encodeSyncCursor({
      txId: 1n,
      id: 0n,
      at: new Date(Date.now() + 3_600_000),
    });
    const near = encodeSyncCursor({
      txId: 1n,
      id: 0n,
      at: new Date(Date.now() + 30_000),
    });

    expect(() => decodeSyncCursor(future)).toThrow("Invalid cursor");
    expect(() => decodeSyncCursor(near)).not.toThrow();
  });
});

describe("tooOldToSync", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const now = new Date("2026-10-31T12:00:00.000Z");
  const today = new Date("2026-10-31T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(today.getTime() - n * DAY);
  const after = (d: Date, ms: number) => new Date(d.getTime() + ms);

  it("accepts any cursor when no partition exists", () => {
    expect(tooOldToSync(daysAgo(400), null, now, 30)).toBe(false);
  });

  it("accepts a cursor within the margin of the oldest day when retention has dropped nothing", () => {
    // A fresh deploy: the oldest partition is yesterday's, well inside retention.
    expect(
      tooOldToSync(after(daysAgo(1), 5 * MINUTE), daysAgo(1), now, 30)
    ).toBe(false);
  });

  it("refuses a cursor within the margin of the oldest day once retention has dropped days", () => {
    expect(
      tooOldToSync(after(daysAgo(30), 5 * MINUTE), daysAgo(30), now, 30)
    ).toBe(true);
    expect(
      tooOldToSync(after(daysAgo(31), 5 * MINUTE), daysAgo(31), now, 30)
    ).toBe(true);
  });

  it("accepts a cursor past the margin once retention has dropped days", () => {
    expect(
      tooOldToSync(after(daysAgo(30), 11 * MINUTE), daysAgo(30), now, 30)
    ).toBe(false);
  });

  it("refuses a cursor older than the oldest retained day", () => {
    expect(tooOldToSync(after(daysAgo(2), 0), daysAgo(1), now, 30)).toBe(true);
    expect(tooOldToSync(daysAgo(40), daysAgo(30), now, 30)).toBe(true);
  });
});
