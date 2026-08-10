/**
 * Pure timing helpers for the CalDAV push task. Kept free of IO so they can be
 * driven by a fake clock in tests.
 *
 * A push worker holds a maintenance claim for a fixed lease. Settings changes
 * wait for that claim, so they cannot commit until the lease frees. To make
 * sure a worker never fires a calendar call at a destination the owner has just
 * changed away from, the worker stops calling out a little before its lease
 * would expire (the safety margin), and every call it does make carries an
 * abort deadline that also lands inside the margin.
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
 * True while there is still enough lease left to start another calendar call.
 * Once the elapsed run time reaches the lease minus the safety margin, the
 * worker stops calling out for the rest of the pass.
 */
export const canStartCall = (
  startedAtMs: number,
  nowMs: number,
  leaseMs = LEASE_MS,
  marginMs = LEASE_SAFETY_MARGIN_MS,
): boolean => nowMs - startedAtMs <= leaseMs - marginMs;

/**
 * How many milliseconds a single calendar call may run before it is aborted.
 * Always lands inside the safety margin, so an in-flight call cannot outlive
 * the lease even if the server hangs.
 */
export const callDeadlineMs = (
  startedAtMs: number,
  nowMs: number,
  leaseMs = LEASE_MS,
  marginMs = LEASE_SAFETY_MARGIN_MS,
): number => Math.max(0, leaseMs - marginMs - (nowMs - startedAtMs));
