import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";

/** Run `fn` inside a fresh query-log context and report both its result and the
 *  number of DB round-trips it took (distinct query start timestamps). Tests use
 *  this to assert an operation batches its writes instead of scaling round-trips
 *  with input size. */
export const runAndCountRoundTrips = async <T>(
  fn: () => Promise<T>,
): Promise<{ value: T; roundTrips: number }> =>
  runWithQueryLogContext(async () => {
    enableQueryLog();
    const value = await fn();
    return {
      roundTrips: new Set(getQueryLog().map((q) => q.startedAtMs)).size,
      value,
    };
  });
