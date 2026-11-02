// @module-tag unit
// @module-tag websocket
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPool } from "../../websocket/pool.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("runPool", () => {
  it("starts the next item as soon as any slot frees, not when its batch ends", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const run = runPool([0, 1, 2], 2, async (i) => {
      started.push(i);
      await gates[i].promise;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    // Item 0 stays slow; item 1 finishing frees a slot for item 2.
    gates[1].resolve();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));

    gates[0].resolve();
    gates[2].resolve();
    await run;
  });

  it("never has more than `concurrency` in flight", async () => {
    let inFlight = 0;
    let most = 0;
    await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      }
    );

    expect(most).toBe(3);
  });

  it("paces the starts evenly over spreadMs", async () => {
    vi.useFakeTimers();
    const started: number[] = [];
    const run = runPool(
      [0, 1, 2, 3],
      4,
      async (i) => {
        started.push(i);
      },
      { spreadMs: 400 }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0]);
    await vi.advanceTimersByTimeAsync(100);
    expect(started).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(200);
    expect(started).toEqual([0, 1, 2, 3]);
    await run;
  });

  it("starts nothing more once stopped", async () => {
    let stopped = false;
    const started: number[] = [];
    await runPool(
      [0, 1, 2, 3],
      1,
      async (i) => {
        started.push(i);
        if (i === 1) stopped = true;
      },
      { stopped: () => stopped }
    );

    expect(started).toEqual([0, 1]);
  });
});
