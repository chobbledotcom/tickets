/** Database headroom required by canonical refund authority work. */

import { DATABASE_MAX_ATTEMPTS } from "#db/client.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";

/** Statements one live authority request makes: identity load, create, arm,
 * answer write, and the lost-revision reread. Admission prices each statement
 * once; retries share REFUND_RETRY_HEADROOM_DATABASE_CALLS. */
export const REFUND_ACTIVE_AUTHORITY_DATABASE_CALLS = 5;

/** Statements a read-only observation that finds durable work makes: identity
 * load, create, transition, and lost-revision reread. */
export const REFUND_OBSERVED_AUTHORITY_DATABASE_CALLS = 4;

/** An authority already known terminal needs only its identity load. */
export const REFUND_TERMINAL_AUTHORITY_DATABASE_CALLS = 1;

/** Shared room for one contended statement to walk the whole retry ladder.
 * Pricing every statement at every physical attempt refused ordinary one- and
 * two-payment refunds; a run that outlives this headroom stops at the
 * subrequest guard and lands in the durable recovery states, so it can be
 * finished later without losing money. */
export const REFUND_RETRY_HEADROOM_DATABASE_CALLS = DATABASE_MAX_ATTEMPTS - 1;

/** Room kept while a provider call is in flight so its answer can always be
 * persisted, including one lost-revision reread. */
export const REFUND_RESULT_DATABASE_RESERVE: SubrequestCounts = {
  database: DATABASE_MAX_ATTEMPTS * 2,
  external: 0,
  total: DATABASE_MAX_ATTEMPTS * 2,
};
