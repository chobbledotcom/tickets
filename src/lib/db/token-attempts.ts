/**
 * Token attempts table operations (404 rate limiting for token URLs)
 *
 * Unlike login_attempts, this tracks DISTINCT tokens attempted within a sliding
 * window. Hitting the same invalid token many times doesn't count — only 5
 * different invalid tokens within TOKEN_WINDOW_MS triggers a lockout. Successful
 * token lookups don't contribute at all.
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
};

/** One recent 404 attempt: hashed token + attempted timestamp (ms epoch) */
type RecentAttempt = { h: string; t: number };

const readRow = (hashedIp: string): Promise<TokenAttemptRow | null> =>
  queryOne<TokenAttemptRow>(
    "SELECT recent_tokens, locked_until FROM token_attempts WHERE ip = ?",
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
 * Tracks DISTINCT hashed tokens within a sliding window; locks out when the
 * count of distinct tokens in the window reaches MAX_TOKEN_404S.
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

  const cutoff = currentMs - TOKEN_WINDOW_MS;
  const existing: RecentAttempt[] = row ? JSON.parse(row.recent_tokens) : [];
  const withinWindow = existing.filter((a) => a.t > cutoff);

  const merged: RecentAttempt[] = [...withinWindow];
  const seen = new Set(withinWindow.map((a) => a.h));
  for (const h of hashedTokens) {
    if (!seen.has(h)) {
      seen.add(h);
      merged.push({ h, t: currentMs });
    }
  }

  if (seen.size >= MAX_TOKEN_404S) {
    const lockedUntil = currentMs + TOKEN_LOCKOUT_MS;
    await getDb().execute({
      args: [hashedIp, "[]", lockedUntil, currentMs],
      sql: "INSERT OR REPLACE INTO token_attempts (ip, recent_tokens, locked_until, last_attempt) VALUES (?, ?, ?, ?)",
    });
    return true;
  }

  await getDb().execute({
    args: [hashedIp, JSON.stringify(merged), currentMs],
    sql: "INSERT OR REPLACE INTO token_attempts (ip, recent_tokens, locked_until, last_attempt) VALUES (?, ?, NULL, ?)",
  });
  return false;
};

/** Clear all token attempts for an IP (used by tests) */
export const clearTokenAttempts = async (ip: string): Promise<void> =>
  deleteByField("token_attempts", "ip", await hmacHash(ip));
