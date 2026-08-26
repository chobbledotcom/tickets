import { delay } from "#shared/now.ts";

/** Passed to a {@link retryWithBackoff} error handler for each failed attempt. */
export type RetryContext = {
  /** Zero-based attempt index that just failed. */
  attempt: number;
  /** Whether another attempt follows (false once the backoffs are exhausted). */
  willRetry: boolean;
};

/**
 * `backoffMs.length` is the number of RETRIES, so there are one more attempts
 * than delays.
 *
 * `onError` may throw to abort: to propagate a non-retryable error, or to swap
 * in a friendlier one once `willRetry` is false. If it does not throw and the
 * retries run out, the last error is rethrown unchanged.
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
