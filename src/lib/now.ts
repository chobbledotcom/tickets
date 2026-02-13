/**
 * Time helpers — return fresh values on every call.
 *
 * On Bunny Edge each request spins up a fresh isolate, so module-level
 * constants used to work. In Deno.serve (dev) and tests the process
 * lives across many requests, so functions avoid stale timestamps.
 */

/** Current time as a Date */
export const now = (): Date => new Date();

/** Full ISO-8601 timestamp for created/logged_at fields */
export const nowIso = (): string => new Date().toISOString();

/** Epoch milliseconds for numeric comparisons */
export const nowMs = (): number => Date.now();
