/** The Square link-expiry limits: pin the values and the registry entries,
 * because the expiry task's pace and budget read from exactly these. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { LIMIT_ENTRIES } from "#shared/limits.ts";
import { DAY_MS } from "#shared/now.ts";
import {
  SQUARE_LINK_EXPIRY_BATCH,
  SQUARE_LINK_EXPIRY_INTERVAL_MINUTES,
  SQUARE_LINK_EXPIRY_INTERVAL_MS,
  SQUARE_LINK_LEASE_MS,
  SQUARE_LINK_RETRY_MS,
  SQUARE_NATIVE_LIFETIME_MS,
} from "#shared/square/limits.ts";

describe("square link expiry limits", () => {
  test("keeps the batch and interval defaults", () => {
    expect(SQUARE_LINK_EXPIRY_BATCH).toBe(10);
    expect(SQUARE_LINK_EXPIRY_INTERVAL_MINUTES).toBe(5);
  });

  test("keeps the lease, retry, and derived interval at five minutes", () => {
    expect(SQUARE_LINK_LEASE_MS).toBe(5 * 60 * 1000);
    expect(SQUARE_LINK_RETRY_MS).toBe(5 * 60 * 1000);
    expect(SQUARE_LINK_EXPIRY_INTERVAL_MS).toBe(
      SQUARE_LINK_EXPIRY_INTERVAL_MINUTES * 60 * 1000,
    );
  });

  test("keeps Square's native lifetime at 180 days", () => {
    expect(SQUARE_NATIVE_LIFETIME_MS).toBe(180 * DAY_MS);
  });

  test("registers the two tunable limits in the debug table", () => {
    const entryKeys = LIMIT_ENTRIES.map((entry) => entry.envKey);
    expect(entryKeys).toContain("SQUARE_LINK_EXPIRY_BATCH");
    expect(entryKeys).toContain("SQUARE_LINK_EXPIRY_INTERVAL_MINUTES");
    const byKey = new Map(LIMIT_ENTRIES.map((entry) => [entry.envKey, entry]));
    expect(byKey.get("SQUARE_LINK_EXPIRY_BATCH")).toEqual({
      current: 10,
      defaultValue: 10,
      envKey: "SQUARE_LINK_EXPIRY_BATCH",
      label: "Square link expiry: links per run",
      unit: "links",
    });
    expect(byKey.get("SQUARE_LINK_EXPIRY_INTERVAL_MINUTES")).toEqual({
      current: 5,
      defaultValue: 5,
      envKey: "SQUARE_LINK_EXPIRY_INTERVAL_MINUTES",
      label: "Square link expiry: how often to look for due links",
      unit: "minutes",
    });
  });
});
