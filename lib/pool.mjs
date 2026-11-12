/**
 * Runs worker(item) with at most `concurrency` in flight. The worker must not throw.
 * gate() runs before each item; it waits while the run is paused and throws when it is stopped.
 */
export async function runPool(items, concurrency, worker, signal, gate) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      if (gate) {
        try { await gate(); } catch { return; }
      }
      if (next >= items.length) return;
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}
