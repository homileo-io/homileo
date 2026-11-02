/**
 * Runs `run` over `items` with at most `concurrency` in flight, each starting as soon as a
 * slot frees. With `spreadMs`, the starts are also paced evenly across that span. No new item
 * starts once `stopped()` holds.
 */
export const runPool = async <T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  o: { spreadMs?: number; stopped?: () => boolean } = {}
): Promise<void> => {
  const gapMs = o.spreadMs && items.length > 1 ? o.spreadMs / items.length : 0;
  const startedAt = Date.now();
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (o.stopped?.()) return;
      const i = next++;
      if (i >= items.length) return;
      const due = startedAt + i * gapMs - Date.now();
      if (due > 0) {
        await new Promise((resolve) => setTimeout(resolve, due).unref());
        if (o.stopped?.()) return;
      }
      await run(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
};
