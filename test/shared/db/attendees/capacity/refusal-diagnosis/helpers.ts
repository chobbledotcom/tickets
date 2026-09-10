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

/** Wait until at least one probe statement has landed in the query log, so
 * a test can change capacity between the diagnosis's batches without
 * racing the batch still in flight. */
export const awaitObservedProbe = async (): Promise<void> => {
  const probeObserved = (): boolean =>
    getQueryLog().some((entry) => entry.sql.includes("AS fits"));
  let spins = 0;
  while (!probeObserved() && spins++ < 5_000) {
    await Promise.resolve();
  }
  if (!probeObserved()) {
    throw new Error("Setup: the probe batch was never observed");
  }
};
