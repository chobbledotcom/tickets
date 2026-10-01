/**
 * Limits of the Square link expiry task. The batch is derived, not set: the
 * edge subrequest budget decides how many links one run can take.
 */

import {
  MAINTENANCE_TASK_CALL_LIMIT,
  TASK_RUNNER_CALL_RESERVE,
} from "#shared/maintenance/definition.ts";
import { DAY_MS } from "#shared/now.ts";

/** What one link costs the task: one claim write, one Square delete, and one
 * move on the answer. The queue read is once per run. */
const CALLS_PER_LINK = 3;

/** How many Square payment links one expiry run may take, which is every
 * link the maintenance call budget can carry. */
export const SQUARE_LINK_EXPIRY_BATCH = Math.floor(
  (MAINTENANCE_TASK_CALL_LIMIT - TASK_RUNNER_CALL_RESERVE - 1) / CALLS_PER_LINK,
);

/** How far apart two runs of the expiry task sit. The checkout window
 * decides when a link is due, so this only spaces the runs; the scheduled
 * monitor's cadence decides how promptly a due link is picked up. */
export const SQUARE_LINK_EXPIRY_INTERVAL_MS = 5 * 60 * 1000;

/** How long a claimed link end may sit without an answer before its lease
 * expires and the row returns to the queue. */
export const SQUARE_LINK_LEASE_MS = 5 * 60 * 1000;

/** How long to wait before asking Square again about a link whose delete
 * answer proved nothing. */
export const SQUARE_LINK_RETRY_MS = 5 * 60 * 1000;

/** How long Square itself keeps an unpaid payment link payable: 180 days
 * from its creation. A handle row older than this plus the webhook window
 * can no longer take payment, whatever this task did. */
export const SQUARE_NATIVE_LIFETIME_MS = 180 * DAY_MS;
