import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { importCatalog } from "#routes/admin/catalog-transfer/import.ts";
import { getListing } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// Package day-price override validation lives in its own file: importing a
// customisable member exercises the read-heavy create helpers, and folding
// these into catalog-transfer.test.ts would tip that file's per-request read
// count past the N+1 guard.

/** The customisable-listing config every case shares: offers 1- and 2-day
 * bookings (so a 5-day override is out of range). */
const customisable = {
  customisableDays: true,
  dayPrices: { 1: 1000, 2: 1800 },
  durationDays: 2,
  listingType: "daily",
} as const;

/** Import a customisable listing that joins package group `group` with a single
 * `overrideDay` package day-price override. */
const importListingOverride = (
  name: string,
  group: string,
  overrideDay: number,
) =>
  importCatalog({
    groups: [{ dayPrices: { [overrideDay]: 500 }, group }],
    kind: "listing",
    listing: { ...customisable, maxAttendees: 1, name },
    version: 1,
  });

/** Import a listing and return its stored row, throwing on any import error. */
const importStoredListing = async (listing: Record<string, unknown>) => {
  const result = await importCatalog({ kind: "listing", listing, version: 1 });
  if (!result.ok) throw new Error(result.error);
  const stored = await getListing(result.id);
  if (!stored) throw new Error("listing not found after import");
  return stored;
};

describeWithEnv("catalog-transfer package day overrides", { db: true }, () => {
  test("filters a listing's own day prices beyond its duration", async () => {
    // The form only reads day_price_1..durationDays; a "5" price on a 2-day
    // listing is inert and must be dropped on import, not persisted where a
    // later duration bump would activate it.
    const stored = await importStoredListing({
      ...customisable,
      dayPrices: { 1: 1000, 5: 5000 },
      maxAttendees: 1,
      name: "Trimmed Days",
    });
    expect(stored.day_prices[1]).toBe(1000);
    expect(stored.day_prices[5]).toBeUndefined();
  });

  test("keeps a day price when no duration is given (defaults to 1)", async () => {
    // No durationDays → the filter compares against the default of 1, so a
    // 1-day price is retained.
    const stored = await importStoredListing({
      customisableDays: true,
      dayPrices: { 1: 1000 },
      listingType: "daily",
      maxAttendees: 1,
      name: "Default Duration",
    });
    expect(stored.day_prices[1]).toBe(1000);
  });

  test("rejects a package member day-override for an unoffered span", async () => {
    // The member offers 1- and 2-day bookings; a 5-day override is a span it
    // doesn't have, so the package editor would never render that input.
    await createTestListing({ ...customisable, name: "Custom Member" });
    const result = await importCatalog({
      group: { isPackage: true, name: "Pkg Custom" },
      kind: "group",
      members: [{ dayPrices: { 5: 500 }, listing: "Custom Member" }],
      version: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("5-day");
  });

  test("accepts a package member day-override for an offered span", async () => {
    await createTestListing({ ...customisable, name: "Custom Member 2" });
    const result = await importCatalog({
      group: { isPackage: true, name: "Pkg Custom 2" },
      kind: "group",
      members: [{ dayPrices: { 2: 500 }, listing: "Custom Member 2" }],
      version: 1,
    });
    if (!result.ok) throw new Error(result.error);
  });

  test("rejects a listing-import package day-override for an unoffered span", async () => {
    // The new listing offers 1- and 2-day bookings; its package membership can't
    // carry a 5-day override.
    await createTestGroup({ isPackage: true, name: "Host Pkg" });
    const result = await importListingOverride("Custom Joiner", "Host Pkg", 5);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("5-day");
  });

  test("accepts a listing-import package day-override for an offered span", async () => {
    await createTestGroup({ isPackage: true, name: "Host Pkg 2" });
    const result = await importListingOverride(
      "Custom Joiner 2",
      "Host Pkg 2",
      2,
    );
    if (!result.ok) throw new Error(result.error);
  });
});
