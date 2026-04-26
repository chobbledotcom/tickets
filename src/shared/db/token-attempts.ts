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
 *     MAX_TOKEN_404S entries; cleared to "[]" once locked).
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

import { hmacHash } from "#lib/crypto/hashing.ts";
import { deleteByField, getDb, queryOne } from "#lib/db/client.ts";
import {
  MAX_TOKEN_404S,
  TOKEN_LOCKOUT_MS,
  TOKEN_WINDOW_MS,
} from "#lib/limits.ts";
import { nowMs } from "#lib/now.ts";

type TokenAttemptRow = {
  recent_tokens: string;
  locked_until: number | null;
  window_start: number;
};

const readRow = (hashedIp: string): Promise<TokenAttemptRow | null> =>
  queryOne<TokenAttemptRow>(
    "SELECT recent_tokens, locked_until, window_start FROM token_attempts WHERE ip = ?",
    [hashedIp],
  );

/**
 * Check if IP is currently locked out of token URLs.
 * Clears expired lockouts so the next attempt starts fresh.
 */
export const isTokenRateLimited = async (ip: string): Promise<boolean> => {
  const hashedIp = await hmacHash(ip);
  const row = await readRow(hashedIp);
  if (!row?.locked_until) return false;

  if (row.locked_until > nowMs()) return true;

  await deleteByField("token_attempts", "ip", hashedIp);
  return false;
};

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
  const row = await readRow(hashedIp);
  const currentMs = nowMs();

  const windowValid = row && currentMs - row.window_start <= TOKEN_WINDOW_MS;
  const windowStart = windowValid ? row.window_start : currentMs;
  const existing: string[] = windowValid ? JSON.parse(row.recent_tokens) : [];

  const merged = new Set(existing);
  for (const h of hashedTokens) merged.add(h);

  if (merged.size >= MAX_TOKEN_404S) {
    const lockedUntil = currentMs + TOKEN_LOCKOUT_MS;
    await getDb().execute({
      args: [hashedIp, "[]", lockedUntil, currentMs, currentMs],
      sql: "INSERT OR REPLACE INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt) VALUES (?, ?, ?, ?, ?)",
    });
    return true;
  }

  await getDb().execute({
    args: [hashedIp, JSON.stringify([...merged]), windowStart, currentMs],
    sql: "INSERT OR REPLACE INTO token_attempts (ip, recent_tokens, locked_until, window_start, last_attempt) VALUES (?, ?, NULL, ?, ?)",
  });
  return false;
};

/**
 * Delete any token_attempts row for this IP.
 * Called on successful token lookups so legitimate users who fat-fingered a
 * URL before getting it right don't leave a fingerprint behind, and as a test
 * helper for resetting state between tests.
 */
export const clearTokenAttempts = async (ip: string): Promise<void> =>
  deleteByField("token_attempts", "ip", await hmacHash(ip));
