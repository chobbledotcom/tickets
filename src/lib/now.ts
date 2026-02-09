/**
 * Request-scoped "now" — consistent for the entire edge script lifecycle.
 * Since the edge runtime spins up fresh per request, a module-level
 * const gives a stable reference that won't drift across midnight.
 */
export const now = new Date();

/** Today's date as YYYY-MM-DD */
export const today = now.toISOString().slice(0, 10);

/** Full ISO-8601 timestamp for created/logged_at fields */
export const nowIso = now.toISOString();

/** Epoch milliseconds for numeric comparisons */
export const nowMs = now.getTime();
