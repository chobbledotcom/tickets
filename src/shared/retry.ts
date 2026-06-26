import { delay } from "#shared/now.ts";

/** Passed to a {@link retryWithBackoff} error handler for each failed attempt. */
export type RetryContext = {
  /** Zero-based attempt index that just failed. */
  attempt: number;
  /** Whether another attempt follows (false once the backoffs are exhausted). */
  willRetry: boolean;
};

/**
 * Run `fn`, retrying after each failure with the matching delay from
 * `backoffMs`. The array's length is the number of retries, so there are
 * `backoffMs.length + 1` attempts in total.
 *
 * After every failed attempt, `onError(error, { attempt, willRetry })` runs. It
 * may throw to abort immediately — to propagate a non-retryable error, or to
 * swap in a friendlier one once the retries are exhausted (`willRetry` false) —
 * otherwise the loop waits `backoffMs[attempt]` and tries again. When the
 * retries are exhausted and `onError` did not throw, the last error is rethrown
 * unchanged.
 *
 * Shared by the database write-lock retry ({@link retryOnDatabaseLock}) and the
 * migration apply retry ({@link applyMigrationWithRetry}).
 */
export const retryWithBackoff = <T>(
  fn: () => Promise<T>,
  backoffMs: readonly number[],
  onError: (error: unknown, context: RetryContext) => void,
): Promise<T> => {
  const attemptFrom = async (attempt: number): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const willRetry = attempt < backoffMs.length;
      onError(error, { attempt, willRetry });
      if (!willRetry) throw error;
      await delay(backoffMs[attempt]!);
      return attemptFrom(attempt + 1);
    }
  };
  return attemptFrom(0);
};
