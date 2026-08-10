/**
 * Pure timing helper for the CalDAV push task. Kept free of IO so it can be
 * driven by a fake clock in tests.
 *
 * A push worker holds a maintenance claim for a fixed lease. Settings changes
 * wait for that claim, so they cannot commit until the lease frees. To make
 * sure a worker never fires a calendar call at a destination the owner has just
 * changed away from, it stops calling out a little before its lease would
 * expire (the safety margin), and every call it does make carries an abort
 * deadline that also lands inside the margin.
 */

/** How long a single push pass may hold its claim before it must stop. */
export const LEASE_MS = 60_000;

/**
 * Stop starting new calendar calls once this little time is left on the lease.
 * The gap covers one in-flight call plus the write that records its result.
 */
export const LEASE_SAFETY_MARGIN_MS = 10_000;

/** Wait at least this long before retrying a listing or delete that failed. */
export const FAILURE_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Milliseconds of lease left before the safety margin.
 *
 * A **positive** result means there is still time to start another calendar
 * call, and the result is that call's abort deadline — so a hung request can't
 * outlive the lease. **Zero or negative** means the worker must stop calling
 * out for the rest of the pass.
 */
export const leaseTimeLeftMs = (startedAtMs: number, nowMs: number): number =>
  LEASE_MS - LEASE_SAFETY_MARGIN_MS - (nowMs - startedAtMs);
