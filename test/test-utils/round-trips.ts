/**
 * Count how many database round-trips a piece of work makes.
 *
 * Several suites prove that a bulk operation stays O(1) round-trips no matter
 * how many rows it touches (a big merge, a big free reservation). They all set
 * up the same little harness: turn on the query log, run the work, then count
 * the distinct start times in the log. That harness lives here once.
 */

import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";

/** Run `work` with the query log on, returning its result plus the number of
 *  distinct database round-trips it made (queries sharing a start time count as
 *  one round-trip, i.e. one batch). */
export const countRoundTrips = async <T>(
  work: () => Promise<T>,
): Promise<{ result: T; roundTrips: number }> =>
  runWithQueryLogContext(async () => {
    enableQueryLog();
    const result = await work();
    return {
      result,
      roundTrips: new Set(getQueryLog().map((q) => q.startedAtMs)).size,
    };
  });
