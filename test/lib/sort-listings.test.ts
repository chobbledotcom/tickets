import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { sortListings } from "#shared/sort-listings.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Holiday, ListingWithCount } from "#shared/types.ts";
import {
  describeWithEnv,
  testListing,
  testListingWithCount,
} from "#test-utils";

const today = () => todayInTz("UTC");

/** Create Bravo/Alpha pair, sort, and assert Alpha comes first */
const expectAlphaBeforeBravo = (
  overrides: Partial<Parameters<typeof testListing>[0]>,
) => {
  const b = testListing({ id: 1, name: "Bravo", ...overrides });
  const a = testListing({ id: 2, name: "Alpha", ...overrides });
  const sorted = sortListings([b, a], []);
  expect(sorted[0]!.name).toBe("Alpha");
  expect(sorted[1]!.name).toBe("Bravo");
};

describeWithEnv("sortListings", { db: true }, () => {
  test("returns empty array for empty input", () => {
    expect(sortListings([], [])).toEqual([]);
  });

  test("returns single listing unchanged", () => {
    const listing = testListing({ name: "Solo" });
    expect(sortListings([listing], [])).toEqual([listing]);
  });

  test("places no-date standard listings before dated standard listings", () => {
    const noDate = testListing({
      date: "",
      id: 1,
      listing_type: "standard",
      name: "Undated",
    });
    const dated = testListing({
      date: "2026-06-15T14:00:00.000Z",
      id: 2,
      listing_type: "standard",
      name: "Dated",
    });

    const sorted = sortListings([dated, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Dated");
  });

  test("places dated standard listings before daily listings", () => {
    const dated = testListing({
      date: "2026-06-15T14:00:00.000Z",
      id: 1,
      listing_type: "standard",
      name: "Dated",
    });
    const daily = testListing({ id: 2, listing_type: "daily", name: "Daily" });

    const sorted = sortListings([daily, dated], []);
    expect(sorted[0]!.name).toBe("Dated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("places no-date standard before daily listings", () => {
    const noDate = testListing({
      date: "",
      id: 1,
      listing_type: "standard",
      name: "Undated",
    });
    const daily = testListing({ id: 2, listing_type: "daily", name: "Daily" });

    const sorted = sortListings([daily, noDate], []);
    expect(sorted[0]!.name).toBe("Undated");
    expect(sorted[1]!.name).toBe("Daily");
  });

  test("sorts no-date standard listings alphabetically by name", () => {
    const c = testListing({
      date: "",
      id: 1,
      listing_type: "standard",
      name: "Charlie",
    });
    const a = testListing({
      date: "",
      id: 2,
      listing_type: "standard",
      name: "Alpha",
    });
    const b = testListing({
      date: "",
      id: 3,
      listing_type: "standard",
      name: "Bravo",
    });

    const sorted = sortListings([c, a, b], []);
    expect(sorted.map((e) => e.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  test("sorts dated standard listings by date ascending", () => {
    const later = testListing({
      date: "2026-09-01T10:00:00.000Z",
      id: 1,
      listing_type: "standard",
      name: "Later",
    });
    const earlier = testListing({
      date: "2026-06-15T14:00:00.000Z",
      id: 2,
      listing_type: "standard",
      name: "Earlier",
    });

    const sorted = sortListings([later, earlier], []);
    expect(sorted[0]!.name).toBe("Earlier");
    expect(sorted[1]!.name).toBe("Later");
  });

  test("sorts dated standard listings by name when dates are equal", () => {
    expectAlphaBeforeBravo({
      date: "2026-06-15T14:00:00.000Z",
      listing_type: "standard",
    });
  });

  test("sorts daily listings by next bookable date ascending", () => {
    const laterDaily = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 5,
      name: "Later Daily",
    });
    const soonerDaily = testListing({
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Sooner Daily",
    });

    const sorted = sortListings([laterDaily, soonerDaily], []);
    expect(sorted[0]!.name).toBe("Sooner Daily");
    expect(sorted[1]!.name).toBe("Later Daily");
  });

  test("sorts daily listings by name when next bookable dates are equal", () => {
    const b = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Bravo Daily",
    });
    const a = testListing({
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Alpha Daily",
    });
    const sorted = sortListings([b, a], []);
    expect(sorted[0]!.name).toBe("Alpha Daily");
    expect(sorted[1]!.name).toBe("Bravo Daily");
  });

  test("places daily listings with no bookable dates after those with dates", () => {
    const hasBookable = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Has Dates",
    });
    const noBookable = testListing({
      bookable_days: [],
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "No Dates",
    });

    const sorted = sortListings([noBookable, hasBookable], []);
    expect(sorted[0]!.name).toBe("Has Dates");
    expect(sorted[1]!.name).toBe("No Dates");
  });

  test("sorts daily listings with no bookable dates by name", () => {
    expectAlphaBeforeBravo({ bookable_days: [], listing_type: "daily" });
  });

  test("places daily listing with bookable dates before one without regardless of input order", () => {
    const withDates = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "With Dates",
    });
    const withoutDates = testListing({
      bookable_days: [],
      id: 2,
      listing_type: "daily",
      name: "Without Dates",
    });

    // Test both input orderings to exercise both dateA="" and dateB="" branches
    const sorted1 = sortListings([withDates, withoutDates], []);
    expect(sorted1[0]!.name).toBe("With Dates");

    const sorted2 = sortListings([withoutDates, withDates], []);
    expect(sorted2[0]!.name).toBe("With Dates");
  });

  test("accounts for holidays when sorting daily listings", () => {
    const todayStr = today();
    // Block the next few days so listing A's first bookable date is pushed later
    const holidays: Holiday[] = [
      {
        end_date: addDays(todayStr, 5),
        id: 1,
        name: "Holiday",
        start_date: addDays(todayStr, 1),
      },
    ];

    const blockedListing = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Blocked",
    });
    const freeListing = testListing({
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Free",
    });

    const sorted = sortListings([blockedListing, freeListing], holidays);
    expect(sorted[0]!.name).toBe("Free");
    expect(sorted[1]!.name).toBe("Blocked");
  });

  test("sorts a mixed list of all three listing types correctly", () => {
    const daily = testListing({
      id: 1,
      listing_type: "daily",
      minimum_days_before: 0,
      name: "Daily Listing",
    });
    const datedStandard = testListing({
      date: "2026-06-15T14:00:00.000Z",
      id: 2,
      listing_type: "standard",
      name: "Dated Standard",
    });
    const nodateStandard = testListing({
      date: "",
      id: 3,
      listing_type: "standard",
      name: "No-Date Standard",
    });

    const sorted = sortListings([daily, datedStandard, nodateStandard], []);
    expect(sorted.map((e) => e.name)).toEqual([
      "No-Date Standard",
      "Dated Standard",
      "Daily Listing",
    ]);
  });

  test("preserves ListingWithCount fields", () => {
    const listing = testListingWithCount({
      attendee_count: 42,
      id: 1,
      name: "Test",
    });
    const sorted = sortListings([listing], []);
    expect((sorted[0] as ListingWithCount).attendee_count).toBe(42);
  });
});
