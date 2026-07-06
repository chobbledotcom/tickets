import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pairEntriesByListing } from "#routes/api/payment-processing.ts";
import { testListingWithCount } from "#test-utils";

/** A validated item carries a listing (the only field the pairing reads). */
const item = (id: number) => ({ listing: testListingWithCount({ id }) });
/** A created booking row — the pairing keys on its `listing_id`. */
const row = (listing_id: number) => ({ listing_id });

describe("pairEntriesByListing", () => {
  test("pairs a one-row-per-item order by listing id", () => {
    const items = [item(10), item(20)];
    const entries = pairEntriesByListing([row(20), row(10)], items);
    // Order-independent: each row resolves to its own listing, not the item at
    // the same array index.
    expect(entries.map((e) => e.attendee.listing_id)).toEqual([20, 10]);
    expect(entries.map((e) => e.listing.id)).toEqual([20, 10]);
  });

  test("maps MORE rows than items — the multi-parent expansion — without mis-aligning", () => {
    // A child (30) chosen under two parents (10, 20) is ONE signed item but TWO
    // per-parent booking rows, so four rows resolve against three items. A
    // positional `validatedItems[i]` pairing would read `validatedItems[3]`
    // (undefined) and throw; the by-id lookup pairs every row correctly.
    const items = [item(10), item(20), item(30)];
    const attendees = [row(10), row(20), row(30), row(30)];
    const entries = pairEntriesByListing(attendees, items);
    expect(entries).toHaveLength(4);
    // Every entry's listing matches its own row's listing id — including both
    // child rows, which share listing 30.
    expect(entries.every((e) => e.attendee.listing_id === e.listing.id)).toBe(
      true,
    );
    expect(entries.filter((e) => e.listing.id === 30)).toHaveLength(2);
  });

  test("resolves a parent-less remainder row (same listing, extra row) too", () => {
    // A remainder row shares the child's listing id (30) with its allocation
    // row, so both resolve to listing 30 — again more rows than items.
    const entries = pairEntriesByListing(
      [row(10), row(30), row(30)],
      [item(10), item(30)],
    );
    expect(entries.map((e) => e.listing.id)).toEqual([10, 30, 30]);
  });
});
