/**
 * Time helpers — return fresh values on every call.
 *
 * On Bunny Edge each request spins up a fresh isolate, so module-level
 * constants used to work. In Deno.serve (dev) and tests the process
 * lives across many requests, so functions avoid stale timestamps.
 */

/** Milliseconds in one day — for whole-day arithmetic on epoch times. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Current time as a Date */
export const now = (): Date => new Date();

/** Full ISO-8601 timestamp for created/logged_at fields */
export const nowIso = (): string => new Date().toISOString();

/** Epoch milliseconds for numeric comparisons */
export const nowMs = (): number => Date.now();

/** ISO timestamp a fixed duration before the current time. */
export const isoBefore = (durationMs: number): string =>
  new Date(nowMs() - durationMs).toISOString();

/** Current time in whole epoch seconds — the unit signed-token expiry uses. */
export const nowSeconds = (): number => Math.floor(nowMs() / 1000);

/**
 * Epoch seconds `maxAgeSeconds` from now — the expiry (`e`) that signed tokens
 * carry, kept in one place so every builder computes it the same way.
 */
export const expiresIn = (maxAgeSeconds: number): number =>
  nowSeconds() + maxAgeSeconds;

/** Resolve after `ms` milliseconds — for retry backoff and similar waits. */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
