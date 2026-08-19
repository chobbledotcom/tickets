import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { sortListings } from "#shared/sort-listings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListing, testListingWithCount } from "#test-utils/factories.ts";
import type { Holiday, ListingWithCount } from "#types";

const today = () => todayInTz("UTC");

/** All orderings of `items` (deterministic, no randomness) */
const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest],
        ),
      );

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
    // Names deliberately contradict date order (Zulu is earlier, Alpha is
    // later) so a comparator that fell back to name comparison would fail.
    const later = testListing({
      date: "2026-09-01T10:00:00.000Z",
      id: 1,
      listing_type: "standard",
      name: "Alpha Late",
    });
    const earlier = testListing({
      date: "2026-06-15T14:00:00.000Z",
      id: 2,
      listing_type: "standard",
      name: "Zulu Early",
    });

    const sorted = sortListings([later, earlier], []);
    expect(sorted[0]!.name).toBe("Zulu Early");
    expect(sorted[1]!.name).toBe("Alpha Late");
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
    // Names deliberately contradict the intended order (Zulu has a bookable
    // date, Alpha doesn't) so a comparator that fell back to name comparison
    // for a single-sided empty date would fail.
    const hasBookable = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Zulu Has Dates",
    });
    const noBookable = testListing({
      bookable_days: [],
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 0,
      name: "Alpha No Dates",
    });

    const sorted = sortListings([noBookable, hasBookable], []);
    expect(sorted[0]!.name).toBe("Zulu Has Dates");
    expect(sorted[1]!.name).toBe("Alpha No Dates");
  });

  test("sorts daily listings with no bookable dates by name", () => {
    expectAlphaBeforeBravo({ bookable_days: [], listing_type: "daily" });
  });

  test("places every daily listing with bookable dates before every one without, regardless of input order", () => {
    // A single fixed input ordering is unreliable here: Array.sort's exact
    // comparator call pattern (which argument is "a" vs "b" for a given
    // pair) depends on the engine's sort algorithm and the input's starting
    // order, so a comparator bug in only one of the dateA/dateB branches can
    // hide behind whichever call pattern one particular ordering happens to
    // produce. Exhaustively trying every ordering of these four listings
    // guarantees every pairwise argument order gets exercised at least once,
    // and the name/date-contradicting names rule out a fallback-to-name
    // escape hatch too.
    const earlierHasDate = testListing({
      id: 1,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 1,
      name: "Delta Has",
    });
    const laterHasDate = testListing({
      id: 2,
      listing_type: "daily",
      maximum_days_after: 30,
      minimum_days_before: 5,
      name: "Bravo Has",
    });
    const noDateC = testListing({
      bookable_days: [],
      id: 3,
      listing_type: "daily",
      name: "Charlie None",
    });
    const noDateA = testListing({
      bookable_days: [],
      id: 4,
      listing_type: "daily",
      name: "Alpha None",
    });

    for (const ordering of permutations([
      earlierHasDate,
      laterHasDate,
      noDateC,
      noDateA,
    ])) {
      const sorted = sortListings(ordering, []);
      expect(sorted.map((l) => l.name)).toEqual([
        "Delta Has",
        "Bravo Has",
        "Alpha None",
        "Charlie None",
      ]);
    }
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
