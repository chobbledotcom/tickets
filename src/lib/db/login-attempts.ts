/**
 * Login attempts table operations (rate limiting)
 */

import { hmacHash } from "#lib/crypto.ts";
import { executeByField, getDb, queryOne } from "#lib/db/client.ts";

/**
 * Rate limiting constants
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

type LoginAttemptRow = { attempts: number; locked_until: number | null };

/** Hash IP and query login attempts, then apply handler function */
const withHashedIpAttempts = async <T>(
  ip: string,
  handler: (hashedIp: string, row: LoginAttemptRow | null) => Promise<T>,
): Promise<T> => {
  const hashedIp = await hmacHash(ip);
  const row = await queryOne<LoginAttemptRow>(
    "SELECT attempts, locked_until FROM login_attempts WHERE ip = ?",
    [hashedIp],
  );
  return handler(hashedIp, row);
};

/**
 * Check if IP is rate limited for login
 */
export const isLoginRateLimited = (ip: string): Promise<boolean> =>
  withHashedIpAttempts(ip, async (hashedIp, row) => {
    if (!row) return false;

    // Check if currently locked out
    if (row.locked_until && row.locked_until > Date.now()) {
      return true;
    }

    // If lockout expired, reset
    if (row.locked_until && row.locked_until <= Date.now()) {
      await executeByField("login_attempts", "ip", hashedIp);
    }

    return false;
  });

/**
 * Record a failed login attempt
 * Returns true if the account is now locked
 */
export const recordFailedLogin = (ip: string): Promise<boolean> =>
  withHashedIpAttempts(ip, async (hashedIp, row) => {
    const newAttempts = (row?.attempts ?? 0) + 1;

    if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      await getDb().execute({
        sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
        args: [hashedIp, newAttempts, lockedUntil],
      });
      return true;
    }

    await getDb().execute({
      sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
      args: [hashedIp, newAttempts],
    });
    return false;
  });

/**
 * Clear login attempts for an IP (on successful login)
 */
export const clearLoginAttempts = async (ip: string): Promise<void> => {
  const hashedIp = await hmacHash(ip);
  await executeByField("login_attempts", "ip", hashedIp);
};
