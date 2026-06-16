/**
 * Booking rate limiting.
 *
 * The public booking endpoint is unauthenticated and creates database rows,
 * sends emails, and fires webhooks, so it is throttled per IP to prevent
 * capacity griefing and registration/webhook flooding. Counters share the
 * `login_attempts` table but are namespaced so they never affect login lockouts.
 */

import { isIpRateLimited, recordIpAttempt } from "#shared/db/login-attempts.ts";
import { BOOKING_LOCKOUT_MS, MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";

/** Namespace so booking counters don't collide with login or other limiters. */
const BOOKING_PREFIX = "book:";

/** Check if an IP has exceeded the booking rate limit. */
export const isBookingRateLimited = (ip: string): Promise<boolean> =>
  isIpRateLimited(ip, BOOKING_PREFIX);

/** Record a booking attempt for an IP; returns true if now locked out. */
export const recordBookingAttempt = (ip: string): Promise<boolean> =>
  recordIpAttempt(ip, BOOKING_PREFIX, MAX_BOOKING_ATTEMPTS, BOOKING_LOCKOUT_MS);
