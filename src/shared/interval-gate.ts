/**
 * Interval gate for fire-and-forget housekeeping tasks.
 *
 * The prune tasks and the activity-log backfill both run little and often from
 * the request handler, each gated by its own "when did I last run" timestamp so
 * it stays inside the edge subrequest budget. They store that timestamp as a
 * ms-epoch string setting; this decides whether enough time has passed to run
 * the task again.
 */

import { parsePositiveInt } from "#shared/limits.ts";

/**
 * True when at least `intervalMs` has passed since the task last ran.
 *
 * `lastRun` is the stored ms-epoch timestamp of the previous run. An empty or
 * unreadable value counts as 0 — "never run", so the task is due right away.
 * Pass the current time in so a caller can gate several tasks against one clock
 * reading.
 */
export const taskIsDue = (
  lastRun: string,
  intervalMs: number,
  now: number,
): boolean => now - parsePositiveInt(lastRun, 0) >= intervalMs;
