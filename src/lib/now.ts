/**
 * Time helpers — return fresh values on every call.
 *
 * On Bunny Edge each request spins up a fresh isolate, so module-level
 * constants used to work. In Deno.serve (dev) and tests the process
 * lives across many requests, so functions avoid stale timestamps.
 */

/** Current time as a Date */
export const now = (): Date => new Date();

/** Today's date as YYYY-MM-DD */
export const today = (): string => new Date().toISOString().slice(0, 10);

/** Full ISO-8601 timestamp for created/logged_at fields */
export const nowIso = (): string => new Date().toISOString();

/** Epoch milliseconds for numeric comparisons */
export const nowMs = (): number => Date.now();
