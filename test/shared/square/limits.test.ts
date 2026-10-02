/** The Square link-expiry limits: pin the values, because the expiry task's
 * pace and budget read from exactly these. The batch is derived, not set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MAINTENANCE_TASK_CALL_LIMIT,
  TASK_RUNNER_CALL_RESERVE,
} from "#shared/maintenance/definition.ts";
import { DAY_MS } from "#shared/now.ts";
import {
  SQUARE_LINK_EXPIRY_BATCH,
  SQUARE_LINK_EXPIRY_INTERVAL_MS,
  SQUARE_LINK_LEASE_MS,
  SQUARE_LINK_RETRY_MS,
  SQUARE_NATIVE_LIFETIME_MS,
} from "#shared/square/limits.ts";

describe("square link expiry limits", () => {
  test("takes every link the maintenance call budget can carry", () => {
    // One link costs three calls, and one queue read heads the run.
    expect(SQUARE_LINK_EXPIRY_BATCH).toBe(10);
    expect(
      1 + SQUARE_LINK_EXPIRY_BATCH * 3 + TASK_RUNNER_CALL_RESERVE,
    ).toBeLessThanOrEqual(MAINTENANCE_TASK_CALL_LIMIT);
  });

  test("keeps the interval, lease, and retry at five minutes", () => {
    expect(SQUARE_LINK_EXPIRY_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(SQUARE_LINK_LEASE_MS).toBe(5 * 60 * 1000);
    expect(SQUARE_LINK_RETRY_MS).toBe(5 * 60 * 1000);
  });

  test("keeps Square's native lifetime at 180 days", () => {
    expect(SQUARE_NATIVE_LIFETIME_MS).toBe(180 * DAY_MS);
  });
});
