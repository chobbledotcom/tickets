/**
 * Run an operation whose retries wait on real `setTimeout` backoffs (e.g.
 * `retryWithBackoff`'s 50/150/350ms) under `FakeTime`, so a test driving the
 * "every retry exhausted" path finishes instantly instead of genuinely
 * sleeping half a second and landing in the slow-tests report. The virtual
 * clock advances timer by timer until the operation settles; the result (or
 * rejection) comes back exactly as the real-time version's would.
 */
import { FakeTime } from "@std/testing/time";

export const withVirtualBackoff = async <T>(
  run: () => Promise<T>,
): Promise<T> => {
  const time = new FakeTime();
  try {
    const state = { settled: false };
    const pending = run().finally(() => {
      state.settled = true;
    });
    // Attach a no-op handler so an early rejection can't surface as an
    // unhandled rejection while the clock is still being advanced; the real
    // rejection re-surfaces at the final await.
    pending.catch(() => {});
    while (!state.settled) {
      await time.nextAsync();
    }
    return await pending;
  } finally {
    time.restore();
  }
};
