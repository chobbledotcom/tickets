/**
 * Hold a piece of production code to a database-call budget from a test.
 *
 * Bunny stops an edge request after 50 subrequests, so a read that grows with
 * its input — one query per cart slug, per order line, per package — is a
 * production outage waiting for a big enough order. These helpers run a block
 * inside a real subrequest budget with a tight allowance, so the loop trips the
 * counter here, in a fast test, instead of in a later audit.
 */

import {
  BUNNY_SUBREQUEST_LIMIT,
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";

/** Run `work` with at most `limit` database calls, and report how many it used.
 * Call `limit + 1` throws, naming the operation that blew the budget. */
export const countDatabaseCalls = async (
  limit: number,
  work: () => Promise<unknown>,
): Promise<number> =>
  runWithSubrequestBudget(() =>
    withSubrequestAllowance(
      {
        database: limit,
        external: BUNNY_SUBREQUEST_LIMIT,
        total: BUNNY_SUBREQUEST_LIMIT,
      },
      async () => {
        await work();
        return getSubrequestUsage().database;
      },
    ),
  );
