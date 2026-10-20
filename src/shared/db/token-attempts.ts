/**
 * 404 rate limiting for token URLs. Unlike login_attempts, this counts DISTINCT
 * tokens in a tumbling window, so repeated hits on the same invalid token do
 * not add up.
 *
 * `recent_tokens` is merged inside the database by the recording statement and
 * never read back into JS.
 *
 * There is deliberately no per-attempt timestamp. One `window_start` enforces
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
import type { SqlParameter } from "#db/numbered-statement.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

/* jscpd:ignore-end */

/** The values one recorded failure carries. */
interface TokenFailureValues {
  hashedIp: string;
  lockDeadline: number;
  /** This request's tokens as a JSON array. */
  newTokens: string;
  now: number;
  tokenLimit: number;
  windowMs: number;
}

/** One statement tumbles the window, merges the new tokens, and applies the
 * lockout — all inside the database, so two failures arriving at once can
 * never lose each other's tokens. Once the merged set reaches the limit the
 * stored set is cleared to "[]" (no fingerprint kept while locked). While a
 * lockout is active, both arms keep it: a straggling failure that queued
 * behind the locking one must not restart the count and drop the lock. */
const recordFailureStatement = (
  bind: SqlParameter,
  values: TokenFailureValues,
): string => {
  const ip = bind(values.hashedIp);
  const newTokens = bind(values.newTokens);
  const tokenLimit = bind(values.tokenLimit);
  const lockDeadline = bind(values.lockDeadline);
  const now = bind(values.now);
  const windowMs = bind(values.windowMs);

  /** The stored tokens that still count: the saved set while the window is
   * live, an empty set once the window has tumbled. */
  const liveTokens = `CASE
    WHEN ${now} - token_attempts.window_start > ${windowMs} THEN '[]'
    ELSE token_attempts.recent_tokens
  END`;

  /** The live tokens and this request's tokens as one set (UNION removes
   * duplicates, so retries of a known token never grow the set). */
  const unionTokens = `(
    SELECT value FROM json_each(${liveTokens})
    UNION
    SELECT value FROM json_each(${newTokens})
  ) AS hashedToken`;

  const mergedCount = `(SELECT count(*) FROM ${unionTokens})`;
  const mergedJson = `(SELECT json_group_array(hashedToken.value) FROM ${unionTokens})`;
  const lockIsActive = `token_attempts.locked_until > ${now}`;

  return `
  INSERT INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt)
  VALUES (
    ${ip},
    CASE WHEN json_array_length(${newTokens}) >= ${tokenLimit} THEN '[]' ELSE ${newTokens} END,
    CASE WHEN json_array_length(${newTokens}) >= ${tokenLimit} THEN ${lockDeadline} ELSE NULL END,
    ${now},
    ${now}
  )
  ON CONFLICT (ip) DO UPDATE SET
    recent_tokens = CASE
      WHEN ${lockIsActive} THEN token_attempts.recent_tokens
      WHEN ${mergedCount} >= ${tokenLimit} THEN '[]'
      ELSE ${mergedJson}
    END,
    locked_until = CASE
      WHEN ${lockIsActive} THEN token_attempts.locked_until
      WHEN ${mergedCount} >= ${tokenLimit} THEN ${lockDeadline}
      ELSE NULL
    END,
    window_start = CASE
      WHEN ${now} - token_attempts.window_start > ${windowMs} THEN ${now}
      ELSE token_attempts.window_start
    END,
    last_attempt = ${now}
  RETURNING locked_until`;
};

const recordFailure = makeAttemptRecorder(recordFailureStatement);

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

  return recordFailure({
    hashedIp,
    lockDeadline: current + TOKEN_LOCKOUT_MS,
    newTokens: JSON.stringify([...new Set(hashedTokens)]),
    now: current,
    tokenLimit: MAX_TOKEN_404S,
    windowMs: TOKEN_WINDOW_MS,
  });
};

/**
 * Delete any token_attempts row for this IP.
 * Called on successful token lookups so legitimate users who fat-fingered a
 * URL before getting it right don't leave a fingerprint behind, and as a test
 * helper for resetting state between tests.
 */
export const clearTokenAttempts: (ip: string) => Promise<void> =
  clearAttemptsFor("token_attempts");
