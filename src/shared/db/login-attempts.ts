/**
 * IP attempt rate limiting (shared `login_attempts` table).
 *
 * A per-IP attempt counter with optional lockout, used for login and other
 * abuse-prone entry points (e.g. public booking). Each call site namespaces its
 * counters with a `prefix` so they never collide — a booking flood can't lock
 * anyone out of logging in, and vice versa. Rows whose lockout has expired are
 * removed on the next check and by pruneLoginAttempts; counter-only rows (no
 * lockout) are left to be overwritten by the next attempt from that IP.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import { deleteByField, getDb, queryOne } from "#shared/db/client.ts";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

type LoginAttemptRow = { attempts: number; locked_until: number | null };

/** Hash the prefixed IP and query its attempt row, then apply the handler */
const withHashedIpAttempts = async <T>(
  ip: string,
  prefix: string,
  handler: (hashedIp: string, row: LoginAttemptRow | null) => Promise<T>,
): Promise<T> => {
  const hashedIp = await hmacHash(`${prefix}${ip}`);
  const row = await queryOne<LoginAttemptRow>(
    "SELECT attempts, locked_until FROM login_attempts WHERE ip = ?",
    [hashedIp],
  );
  return handler(hashedIp, row);
};

/** Check if lockout is active, resetting expired locks */
const checkLockout = async (
  hashedIp: string,
  row: LoginAttemptRow | null,
): Promise<boolean> => {
  if (!row) return false;

  const currentMs = nowMs();

  // Check if currently locked out
  if (row.locked_until && row.locked_until > currentMs) {
    return true;
  }

  // If lockout expired, reset
  if (row.locked_until && row.locked_until <= currentMs) {
    await deleteByField("login_attempts", "ip", hashedIp);
  }

  return false;
};

/** Build an attempt recorder with the given threshold/lockout window. */
const makeRecordAttempt =
  (maxAttempts: number, lockoutMs: number) =>
  async (hashedIp: string, row: LoginAttemptRow | null): Promise<boolean> => {
    const newAttempts = (row?.attempts ?? 0) + 1;

    if (newAttempts >= maxAttempts) {
      const lockedUntil = nowMs() + lockoutMs;
      await getDb().execute({
        args: [hashedIp, newAttempts, lockedUntil],
        sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      });
      return true;
    }

    await getDb().execute({
      args: [hashedIp, newAttempts],
      sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
    });
    return false;
  };

/**
 * Check whether an IP (namespaced by `prefix`) is currently locked out.
 */
export const isIpRateLimited = (ip: string, prefix: string): Promise<boolean> =>
  withHashedIpAttempts(ip, prefix, checkLockout);

/**
 * Record one attempt for an IP (namespaced by `prefix`), locking it out for
 * `lockoutMs` once `maxAttempts` is reached. Returns true if now locked.
 */
export const recordIpAttempt = (
  ip: string,
  prefix: string,
  maxAttempts: number,
  lockoutMs: number,
): Promise<boolean> =>
  withHashedIpAttempts(ip, prefix, makeRecordAttempt(maxAttempts, lockoutMs));

/**
 * Check if IP is rate limited for login.
 */
export const isLoginRateLimited = (ip: string): Promise<boolean> =>
  isIpRateLimited(ip, "");

/**
 * Record a failed login attempt.
 * Returns true if the account is now locked.
 */
export const recordFailedLogin = (ip: string): Promise<boolean> =>
  recordIpAttempt(ip, "", MAX_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MS);

/**
 * Clear login attempts for an IP (on successful login)
 */
export const clearLoginAttempts = async (ip: string): Promise<void> => {
  const hashedIp = await hmacHash(ip);
  await deleteByField("login_attempts", "ip", hashedIp);
};
