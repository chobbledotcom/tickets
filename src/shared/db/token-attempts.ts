/**
 * Token attempts table operations (404 rate limiting for token URLs)
 *
 * Unlike login_attempts, this tracks DISTINCT tokens attempted within a
 * tumbling window. Hitting the same invalid token many times doesn't count —
 * only MAX_TOKEN_404S distinct invalid tokens inside a single TOKEN_WINDOW_MS
 * window trigger a TOKEN_LOCKOUT_MS lockout.
 *
 * Data stored per IP (hashed):
 *   - recent_tokens: JSON array of hashed tokens in the current window (max
 *     MAX_TOKEN_404S entries; cleared to "[]" once locked). Only ever written
 *     by the single recording statement below, which merges inside the
 *     database — the stored set is never read back into JS.
 *   - window_start: ms-epoch when the current counting window began. When
 *     now - window_start exceeds TOKEN_WINDOW_MS the window tumbles and the
 *     counter resets.
 *   - locked_until / last_attempt: lockout timestamp and last-touched marker
 *     (the latter drives prune).
 *
 * We intentionally do NOT store a per-attempt timestamp for each hashed token.
 * A single window_start is enough to enforce the limit and keeps the on-disk
 * profile (timing of individual invalid-link clicks) small.
 */

/* jscpd:ignore-start */
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  clearAttemptsFor,
  isIpLockedOut,
  makeAttemptRecorder,
} from "#shared/db/attempt-lockout.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

/* jscpd:ignore-end */

/** The stored tokens that still count: the saved set while the window is
 * live, an empty set once the window has tumbled. Params: now, window ms. */
const LIVE_TOKENS = `CASE
  WHEN ? - token_attempts.window_start > ? THEN '[]'
  ELSE token_attempts.recent_tokens
END`;

/** The live tokens and this request's tokens as one set (UNION removes
 * duplicates, so retries of a known token never grow the set).
 * Params: now, window ms, new-tokens JSON. */
const UNION_TOKENS = `(
  SELECT value FROM json_each(${LIVE_TOKENS})
  UNION
  SELECT value FROM json_each(?)
) AS hashedToken`;

const MERGED_COUNT = `(SELECT count(*) FROM ${UNION_TOKENS})`;
const MERGED_JSON = `(SELECT json_group_array(hashedToken.value) FROM ${UNION_TOKENS})`;

/** One statement tumbles the window, merges the new tokens, and applies the
 * lockout — all inside the database, so two failures arriving at once can
 * never lose each other's tokens. Once the merged set reaches the limit the
 * stored set is cleared to "[]" (no fingerprint kept while locked). While a
 * lockout is active, both arms keep it: a straggling failure that queued
 * behind the locking one must not restart the count and drop the lock. */
const RECORD_FAILURE_SQL = `
  INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt)
  VALUES (
    ?,
    CASE WHEN json_array_length(?) >= ? THEN '[]' ELSE ? END,
    CASE WHEN json_array_length(?) >= ? THEN ? ELSE NULL END,
    ?,
    ?
  )
  ON CONFLICT (ip) DO UPDATE SET
    recent_tokens = CASE
      WHEN token_attempts.locked_until > ? THEN token_attempts.recent_tokens
      WHEN ${MERGED_COUNT} >= ? THEN '[]'
      ELSE ${MERGED_JSON}
    END,
    locked_until = CASE
      WHEN token_attempts.locked_until > ? THEN token_attempts.locked_until
      WHEN ${MERGED_COUNT} >= ? THEN ?
      ELSE NULL
    END,
    window_start = CASE
      WHEN ? - token_attempts.window_start > ? THEN ?
      ELSE token_attempts.window_start
    END,
    last_attempt = ?
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
  const newTokensJson = JSON.stringify([...new Set(hashedTokens)]);
  const current = nowMs();
  const lockedUntil = current + TOKEN_LOCKOUT_MS;

  return recordFailure([
    hashedIp,
    // VALUES recent_tokens: a big enough first burst locks immediately
    newTokensJson,
    MAX_TOKEN_404S,
    newTokensJson,
    // VALUES locked_until
    newTokensJson,
    MAX_TOKEN_404S,
    lockedUntil,
    // VALUES window_start, last_attempt
    current,
    current,
    // SET recent_tokens: active-lock guard, merged count, limit, merged set
    current,
    current,
    TOKEN_WINDOW_MS,
    newTokensJson,
    MAX_TOKEN_404S,
    current,
    TOKEN_WINDOW_MS,
    newTokensJson,
    // SET locked_until: active-lock guard, merged count, limit, deadline
    current,
    current,
    TOKEN_WINDOW_MS,
    newTokensJson,
    MAX_TOKEN_404S,
    lockedUntil,
    // SET window_start: tumble to now when the old window has passed
    current,
    TOKEN_WINDOW_MS,
    current,
    // SET last_attempt
    current,
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
