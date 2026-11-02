/** Resolves after `ms`, or at once when `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms).unref();
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Runs `run` over `items` with at most `concurrency` in flight, each starting as soon as a
 * slot frees. With `spreadMs`, the starts are also paced evenly across that span. Once `signal`
 * aborts, no new item starts and the paced waits end at once.
 */
export const runPool = async <T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  o: { spreadMs?: number; signal?: AbortSignal } = {}
): Promise<void> => {
  const gapMs = o.spreadMs && items.length > 1 ? o.spreadMs / items.length : 0;
  const startedAt = Date.now();
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (o.signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      const due = startedAt + i * gapMs - Date.now();
      if (due > 0) {
        await pause(due, o.signal);
        if (o.signal?.aborted) return;
      }
      await run(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
};
