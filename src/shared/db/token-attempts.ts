/**
 * Token attempts table operations (404 rate limiting for token URLs)
 *
 * Unlike login_attempts, this tracks DISTINCT tokens attempted within a
 * tumbling window. Hitting the same invalid token many times doesn't count —
 * only MAX_TOKEN_404S distinct invalid tokens inside a single TOKEN_WINDOW_MS
 * window trigger a TOKEN_LOCKOUT_MS lockout.
 *
 * Per hashed IP it stores `recent_tokens` (the window's hashed tokens, merged
 * inside the database by the recording statement below and never read back into
 * JS), `window_start` (which tumbles once TOKEN_WINDOW_MS passes), and
 * `locked_until` / `last_attempt`, the latter driving prune.
 *
 * There is deliberately no per-attempt timestamp: one `window_start` enforces
 * the limit, and storing less keeps the timing of individual invalid-link
 * clicks off disk.
 */

/* jscpd:ignore-start */
import { hmacHash } from "#crypto/hashing.ts";
import {
  clearAttemptsFor,
  isIpLockedOut,
  makeAttemptRecorder,
} from "#db/attempt-lockout.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

/* jscpd:ignore-end */

/** The numbered parameters every fragment below shares:
 *  ?1 hashed IP · ?2 this request's tokens as a JSON array · ?3 the distinct-
 *  token limit · ?4 the lockout deadline · ?5 now · ?6 the window length. */
const IP = "?1";
const NEW_TOKENS = "?2";
const TOKEN_LIMIT = "?3";
const LOCK_DEADLINE = "?4";
const NOW = "?5";
const WINDOW_MS = "?6";

/** The stored tokens that still count: the saved set while the window is
 * live, an empty set once the window has tumbled. */
const LIVE_TOKENS = `CASE
  WHEN ${NOW} - token_attempts.window_start > ${WINDOW_MS} THEN '[]'
  ELSE token_attempts.recent_tokens
END`;

/** The live tokens and this request's tokens as one set (UNION removes
 * duplicates, so retries of a known token never grow the set). */
const UNION_TOKENS = `(
  SELECT value FROM json_each(${LIVE_TOKENS})
  UNION
  SELECT value FROM json_each(${NEW_TOKENS})
) AS hashedToken`;

const MERGED_COUNT = `(SELECT count(*) FROM ${UNION_TOKENS})`;
const MERGED_JSON = `(SELECT json_group_array(hashedToken.value) FROM ${UNION_TOKENS})`;

const LOCK_IS_ACTIVE = `token_attempts.locked_until > ${NOW}`;

/** One statement tumbles the window, merges the new tokens, and applies the
 * lockout — all inside the database, so two failures arriving at once can
 * never lose each other's tokens. Once the merged set reaches the limit the
 * stored set is cleared to "[]" (no fingerprint kept while locked). While a
 * lockout is active, both arms keep it: a straggling failure that queued
 * behind the locking one must not restart the count and drop the lock. */
const RECORD_FAILURE_SQL = `
  INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt)
  VALUES (
    ${IP},
    CASE WHEN json_array_length(${NEW_TOKENS}) >= ${TOKEN_LIMIT} THEN '[]' ELSE ${NEW_TOKENS} END,
    CASE WHEN json_array_length(${NEW_TOKENS}) >= ${TOKEN_LIMIT} THEN ${LOCK_DEADLINE} ELSE NULL END,
    ${NOW},
    ${NOW}
  )
  ON CONFLICT (ip) DO UPDATE SET
    recent_tokens = CASE
      WHEN ${LOCK_IS_ACTIVE} THEN token_attempts.recent_tokens
      WHEN ${MERGED_COUNT} >= ${TOKEN_LIMIT} THEN '[]'
      ELSE ${MERGED_JSON}
    END,
    locked_until = CASE
      WHEN ${LOCK_IS_ACTIVE} THEN token_attempts.locked_until
      WHEN ${MERGED_COUNT} >= ${TOKEN_LIMIT} THEN ${LOCK_DEADLINE}
      ELSE NULL
    END,
    window_start = CASE
      WHEN ${NOW} - token_attempts.window_start > ${WINDOW_MS} THEN ${NOW}
      ELSE token_attempts.window_start
    END,
    last_attempt = ${NOW}
  RETURNING locked_until`;

const recordFailure = makeAttemptRecorder(RECORD_FAILURE_SQL);

/**
 * Check if IP is currently locked out of token URLs.
 * Clears expired lockouts so the next attempt starts fresh.
 */
export const isTokenRateLimited = async (ip: string): Promise<boolean> =>
  isIpLockedOut("token_attempts", await hmacHash(ip));

/**
 * Record one or more failed token lookups (404) for an IP.
 * Tracks DISTINCT hashed tokens within the current tumbling window; locks out
 * when the count of distinct tokens reaches MAX_TOKEN_404S.
 * Returns true if the IP is now locked.
 */
export const recordTokenFailure = async (
  ip: string,
  tokens: string[],
): Promise<boolean> => {
  if (tokens.length === 0) return false;

  const hashedIp = await hmacHash(ip);
  const hashedTokens = await Promise.all(tokens.map((t) => hmacHash(t)));
  const current = nowMs();

  // One value per numbered parameter, in ?1..?6 order.
  return recordFailure([
    hashedIp,
    JSON.stringify([...new Set(hashedTokens)]),
    MAX_TOKEN_404S,
    current + TOKEN_LOCKOUT_MS,
    current,
    TOKEN_WINDOW_MS,
  ]);
};

/**
 * Delete any token_attempts row for this IP.
 * Called on successful token lookups so legitimate users who fat-fingered a
 * URL before getting it right don't leave a fingerprint behind, and as a test
 * helper for resetting state between tests.
 */
export const clearTokenAttempts: (ip: string) => Promise<void> =
  clearAttemptsFor("token_attempts");
