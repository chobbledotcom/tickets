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

import { hmacHash } from "#crypto/hashing.ts";
import {
  clearAttemptsFor,
  isIpLockedOut,
  makeAttemptRecorder,
} from "#db/attempt-lockout.ts";
import {
  atLeast,
  greaterThan,
  lessThan,
  valued,
  when,
  wholeCondition,
} from "#db/select/expression.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { type Changes, insertInto } from "#db/write.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

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
const recordFailureStatement = (values: TokenFailureValues): SqlStatement => {
  const { lockDeadline, newTokens, now, tokenLimit } = values;
  const firstFull = wholeCondition(
    sql`json_array_length(${newTokens}) >= ${tokenLimit}`,
  );

  return insertInto(
    tables.token_attempts,
    {
      ip: values.hashedIp,
      last_attempt: now,
      locked_until: valued(
        sql`CASE WHEN ${firstFull} THEN ${lockDeadline} ELSE NULL END`,
      ),
      recent_tokens: when([[firstFull, "[]"]], newTokens),
      window_start: now,
    },
    { onConflict: { on: ["ip"], set: laterFailure(values) } },
  ).returning("locked_until");
};

/** The changes to the stored row of an IP that failed before. */
const laterFailure =
  (values: TokenFailureValues) =>
  (row: Node<"token_attempts">): Changes<"token_attempts"> => {
    const { lockDeadline, newTokens, now, tokenLimit, windowMs } = values;
    const tumbled = lessThan(row.window_start, now - windowMs);

    /** The stored tokens that still count: the saved set while the window is
     * live, an empty set once the window has tumbled. */
    const liveTokens = when<string>([[tumbled, "[]"]], row.recent_tokens);

    /** The live tokens and this request's tokens as one set (UNION removes
     * duplicates, so retries of a known token never grow the set). */
    const unionTokens = sql`(
    SELECT value FROM json_each(${liveTokens})
    UNION
    SELECT value FROM json_each(${newTokens})
  ) AS hashedToken`;

    const mergedFull = atLeast(
      valued<number>(sql`(SELECT count(*) FROM ${unionTokens})`),
      tokenLimit,
    );
    const mergedJson = valued<string>(
      sql`(SELECT json_group_array(hashedToken.value) FROM ${unionTokens})`,
    );
    const lockIsActive = greaterThan(row.locked_until, now);
    return {
      last_attempt: now,
      locked_until: valued(
        sql`CASE WHEN ${lockIsActive} THEN ${row.locked_until} WHEN ${mergedFull} THEN ${lockDeadline} ELSE NULL END`,
      ),
      recent_tokens: when<string>(
        [
          [lockIsActive, row.recent_tokens],
          [mergedFull, "[]"],
        ],
        mergedJson,
      ),
      window_start: when([[tumbled, now]], row.window_start),
    };
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
