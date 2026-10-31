// @module-tag int
// @module-tag events
import { changeBus, publishCommitted } from "../../utils/changeBus.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEvent } from "../../utils/changes.js";
import { logger } from "../../utils/logger.js";

describe("publishCommitted", () => {
  afterEach(() => {
    changeBus.removeAllListeners();
    vi.restoreAllMocks();
  });

  it("delivers to every listener when an earlier one throws or rejects, and logs each", async () => {
    const events = [{ id: "1" }] as unknown as ChangeEvent[];
    const logged: unknown[] = [];
    vi.spyOn(logger, "error").mockImplementation(((obj: unknown) => {
      logged.push(obj);
    }) as typeof logger.error);
    const received: ChangeEvent[][] = [];
    changeBus.on("committed", function throwing() {
      throw new Error("sync failure");
    });
    changeBus.on("committed", async function rejecting() {
      throw new Error("async failure");
    });
    changeBus.on("committed", (e: ChangeEvent[]) => received.push(e));

    publishCommitted(events);

    expect(received).toEqual([events]);
    await expect.poll(() => logged.length).toBe(2);
    expect(logged).toEqual([
      expect.objectContaining({
        listener: "throwing",
        err: expect.objectContaining({ message: "sync failure" }),
      }),
      expect.objectContaining({
        listener: "rejecting",
        err: expect.objectContaining({ message: "async failure" }),
      }),
    ]);
  });
});
