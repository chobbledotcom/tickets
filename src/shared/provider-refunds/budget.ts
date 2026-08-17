/** Physical database headroom required by canonical refund authority work. */

import { DATABASE_MAX_ATTEMPTS } from "#shared/db/client.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";

/** Worst-case physical database calls for a live authority request: identity
 * load, create, arm, answer write, and the lost-revision reread. Callers use
 * this complete envelope at admission instead of guessing from logical SQL. */
export const REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS = DATABASE_MAX_ATTEMPTS * 5;

/** Worst-case physical database calls for a read-only observation that finds
 * durable work: identity load, create, transition, and lost-revision reread. */
export const REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS =
  DATABASE_MAX_ATTEMPTS * 4;

/** Room kept while a provider call is in flight so its answer can always be
 * persisted, including one lost-revision reread. */
export const REFUND_RESULT_DATABASE_RESERVE: SubrequestCounts = {
  database: DATABASE_MAX_ATTEMPTS * 2,
  external: 0,
  total: DATABASE_MAX_ATTEMPTS * 2,
};
