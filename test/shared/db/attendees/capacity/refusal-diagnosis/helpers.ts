/** Shared fixtures for the refusal-diagnosis test files. */

import type { LineBooking } from "#db/attendee-types.ts";
import { getQueryLog } from "#db/query-log.ts";

const DAY = "2026-10-01";

export const line = (
  listingId: number,
  date: string | null = null,
  quantity = 1,
): LineBooking => ({ date, durationDays: 1, listingId, quantity });

export { DAY };

const AWAIT_PROBE_TIMEOUT_MS = 5_000;

/** Wait until at least one probe statement has landed in the query log, so
 * a test can change capacity between the diagnosis's batches without racing
 * the batch still in flight. Yields to the macrotask queue with a wall-clock
 * deadline: a microtask spin cannot observe an I/O-backed batch, because
 * microtasks drain before the batch's network round trip resolves. */
export const awaitObservedProbe = async (): Promise<void> => {
  const probeObserved = (): boolean =>
    getQueryLog().some((entry) => entry.sql.includes("AS fits"));
  const deadline = Date.now() + AWAIT_PROBE_TIMEOUT_MS;
  while (!probeObserved() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!probeObserved()) {
    throw new Error("Setup: the probe batch was never observed");
  }
};
