/**
 * IP attempt rate limiting (shared `login_attempts` table).
 *
 * A per-IP attempt counter with optional lockout, used for login and other
 * abuse-prone entry points (e.g. public booking). Each call site namespaces its
 * counters with a `prefix` so they never collide — a booking flood can't lock
 * anyone out of logging in, and vice versa. Rows whose lockout has expired are
 * removed on the next check and by database pruning; counter-only rows carry a
 * `last_attempt` stamp so pruning can remove the stale ones.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  clearAttemptsFor,
  isIpLockedOut,
  makeAttemptRecorder,
} from "#shared/db/attempt-lockout.ts";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";

/** One statement counts the attempt and applies the lockout: the VALUES arm
 * covers an IP's first attempt, the conflict arm every later one, and both
 * decide the lockout inside the database — concurrent attempts each land as
 * their own increment instead of overwriting a shared read.
 * Numbered parameters: ?1 hashed IP · ?2 the attempt limit · ?3 the lockout
 * deadline · ?4 now. */
const RECORD_ATTEMPT_SQL = `
  INSERT INTO login_attempts (ip, attempts, locked_until, last_attempt)
  VALUES (?1, 1, CASE WHEN 1 >= ?2 THEN ?3 ELSE NULL END, ?4)
  ON CONFLICT (ip) DO UPDATE SET
    attempts = login_attempts.attempts + 1,
    locked_until = CASE
      WHEN login_attempts.attempts + 1 >= ?2 THEN ?3
      ELSE NULL
    END,
    last_attempt = ?4
  RETURNING locked_until`;

const recordAttempt = makeAttemptRecorder(RECORD_ATTEMPT_SQL);

/**
 * Check whether an IP (namespaced by `prefix`) is currently locked out.
 */
const isIpRateLimited = async (ip: string, prefix: string): Promise<boolean> =>
  isIpLockedOut("login_attempts", await hmacHash(`${prefix}${ip}`));

/**
 * Record one attempt for an IP (namespaced by `prefix`), locking it out for
 * `lockoutMs` once `maxAttempts` is reached. Returns true if now locked.
 */
const recordIpAttempt = async (
  ip: string,
  prefix: string,
  maxAttempts: number,
  lockoutMs: number,
): Promise<boolean> => {
  const hashedIp = await hmacHash(`${prefix}${ip}`);
  const current = nowMs();
  // One value per numbered parameter, in ?1..?4 order.
  return recordAttempt([hashedIp, maxAttempts, current + lockoutMs, current]);
};

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
