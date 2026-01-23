/**
 * Login attempts table operations (rate limiting)
 */

import { executeByField, getDb, queryOne } from "#lib/db/client.ts";

/**
 * Rate limiting constants
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/** Query login attempts for an IP */
const getLoginAttempts = async (ip: string) =>
  queryOne<{ attempts: number; locked_until: number | null }>(
    "SELECT attempts, locked_until FROM login_attempts WHERE ip = ?",
    [ip],
  );

/**
 * Check if IP is rate limited for login
 */
export const isLoginRateLimited = async (ip: string): Promise<boolean> => {
  const row = await getLoginAttempts(ip);
  if (!row) return false;

  // Check if currently locked out
  if (row.locked_until && row.locked_until > Date.now()) {
    return true;
  }

  // If lockout expired, reset
  if (row.locked_until && row.locked_until <= Date.now()) {
    await executeByField("login_attempts", "ip", ip);
    return false;
  }

  return false;
};

/**
 * Record a failed login attempt
 * Returns true if the account is now locked
 */
export const recordFailedLogin = async (ip: string): Promise<boolean> => {
  const row = await getLoginAttempts(ip);
  const newAttempts = (row?.attempts ?? 0) + 1;

  if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    await getDb().execute({
      sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      args: [ip, newAttempts, lockedUntil],
    });
    return true;
  }

  await getDb().execute({
    sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
    args: [ip, newAttempts],
  });
  return false;
};

/**
 * Clear login attempts for an IP (on successful login)
 */
export const clearLoginAttempts = async (ip: string): Promise<void> =>
  executeByField("login_attempts", "ip", ip);
