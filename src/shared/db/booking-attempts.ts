/**
 * Booking rate limiting.
 *
 * The public booking endpoint is unauthenticated and creates database rows,
 * sends emails, and fires webhooks, so it is throttled per IP to prevent
 * capacity griefing and registration/webhook flooding. Counters share the
 * `login_attempts` table but are namespaced so they never affect login lockouts.
 */

import { makeIpRateLimiter } from "#shared/db/login-attempts.ts";
import { BOOKING_LOCKOUT_MS, MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";

/** "book:" namespaces the counters away from login and other limiters. */
const limiter = makeIpRateLimiter(
  "book:",
  MAX_BOOKING_ATTEMPTS,
  BOOKING_LOCKOUT_MS,
);

/** Check if an IP has exceeded the booking rate limit. */
export const isBookingRateLimited = limiter.isLimited;

/** Record a booking attempt for an IP; returns true if now locked out. */
export const recordBookingAttempt = limiter.record;
