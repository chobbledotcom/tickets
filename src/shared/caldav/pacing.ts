/**
 * Pure timing helper for the CalDAV push task. Kept free of IO so it can be
 * driven by a fake clock in tests.
 *
 * A push worker runs under a maintenance claim with an absolute deadline handed
 * to it by the runner (its own task deadline, capped by the request deadline).
 * Settings changes wait for that claim, so they cannot commit until the worker
 * finishes and releases. To make sure a worker never fires a calendar call at a
 * destination the owner has just changed away from, it stops calling out a
 * little before that deadline, and every call it does make carries an abort
 * deadline that also lands before it.
 */

/**
 * Reserve this much time before the maintenance deadline to record the last
 * call's result. A calendar call must both start and abort this long before
 * the deadline, so its outcome is written while the worker still holds its
 * claim — and settings changes, which wait for that claim, stay blocked until
 * then.
 */
export const RESULT_WRITE_MARGIN_MS = 2_000;

/** Wait at least this long before retrying a listing or delete that failed. */
export const FAILURE_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Milliseconds the next calendar call may run before the maintenance deadline.
 *
 * A **positive** result means there is still time to start another call, and
 * the result is that call's abort deadline — so a hung request can't outlive
 * the claim. **Zero or negative** means the worker must stop calling out for
 * the rest of the pass.
 */
export const callTimeLeftMs = (deadlineMs: number, nowMs: number): number =>
  deadlineMs - nowMs - RESULT_WRITE_MARGIN_MS;
