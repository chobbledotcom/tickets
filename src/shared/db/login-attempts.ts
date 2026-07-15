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
import { clearAttemptsFor, lockoutActive } from "#shared/db/attempt-lockout.ts";
import { execute, queryOne } from "#shared/db/client.ts";
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

/** Check if lockout is active, resetting expired locks. A missing row (no
 * attempts yet) reads as not limited. */
const checkLockout = (
  hashedIp: string,
  row: LoginAttemptRow | null,
): Promise<boolean> =>
  lockoutActive("login_attempts", hashedIp, row?.locked_until);

/** Build an attempt recorder with the given threshold/lockout window. */
const makeRecordAttempt =
  (maxAttempts: number, lockoutMs: number) =>
  async (hashedIp: string, row: LoginAttemptRow | null): Promise<boolean> => {
    const newAttempts = (row?.attempts ?? 0) + 1;

    if (newAttempts >= maxAttempts) {
      const lockedUntil = nowMs() + lockoutMs;
      await execute(
        "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
        [hashedIp, newAttempts, lockedUntil],
      );
      return true;
    }

    await execute(
      "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
      [hashedIp, newAttempts],
    );
    return false;
  };

/**
 * Check whether an IP (namespaced by `prefix`) is currently locked out.
 */
const isIpRateLimited = (ip: string, prefix: string): Promise<boolean> =>
  withHashedIpAttempts(ip, prefix, checkLockout);

/**
 * Record one attempt for an IP (namespaced by `prefix`), locking it out for
 * `lockoutMs` once `maxAttempts` is reached. Returns true if now locked.
 */
const recordIpAttempt = (
  ip: string,
  prefix: string,
  maxAttempts: number,
  lockoutMs: number,
): Promise<boolean> =>
  withHashedIpAttempts(ip, prefix, makeRecordAttempt(maxAttempts, lockoutMs));

/**
 * Build a namespaced per-IP limiter: `isLimited` checks the lockout,
 * `record` counts one attempt (locking out at `maxAttempts` for `lockoutMs`
 * and returning true once locked). Each caller picks its own `prefix` so
 * counters never collide across features.
 */
export const makeIpRateLimiter = (
  prefix: string,
  maxAttempts: number,
  lockoutMs: number,
): {
  isLimited: (ip: string) => Promise<boolean>;
  record: (ip: string) => Promise<boolean>;
} => ({
  isLimited: (ip) => isIpRateLimited(ip, prefix),
  record: (ip) => recordIpAttempt(ip, prefix, maxAttempts, lockoutMs),
});

export const loginLimiter = makeIpRateLimiter(
  "",
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCKOUT_MS,
);

/**
 * Clear login attempts for an IP on successful login. Clearing is login-only:
 * successful API-key, booking, and address requests must retain their counters.
 */
export const clearLoginAttempts: (ip: string) => Promise<void> =
  clearAttemptsFor("login_attempts");
