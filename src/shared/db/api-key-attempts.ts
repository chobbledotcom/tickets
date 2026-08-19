/**
 * API-key (Bearer) authentication rate limiting.
 *
 * Only *failed* Bearer lookups are counted, so legitimate clients with a valid
 * key are never throttled. This caps brute-force guessing and the database load
 * of a token-guessing flood. Counters share the login_attempts table under a
 * dedicated namespace and are cleaned by database pruning.
 */

import { makeIpRateLimiter } from "#db/login-attempts.ts";
import { APIKEY_LOCKOUT_MS, MAX_APIKEY_ATTEMPTS } from "#shared/limits.ts";

/** Namespace so API-key counters don't collide with login or booking limiters. */
const APIKEY_PREFIX = "apikey:";

export const apiKeyLimiter = makeIpRateLimiter(
  APIKEY_PREFIX,
  MAX_APIKEY_ATTEMPTS,
  APIKEY_LOCKOUT_MS,
);
