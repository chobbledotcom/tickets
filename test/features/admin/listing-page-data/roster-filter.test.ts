/**
 * Reading the roster tab's filter out of the query string. A bogus date must
 * be ignored rather than filtering every attendee off the page, and only a
 * daily listing has dates to filter by at all.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rosterFilterFromQuery } from "#routes/admin/listing-page-data.ts";
import type { ListingType, ListingWithCount } from "#shared/types.ts";

const listingOfType = (listing_type: ListingType): ListingWithCount =>
  ({ id: 1, listing_type }) as ListingWithCount;

const DAILY = listingOfType("daily");
const STANDARD = listingOfType("standard");

const filterFor = (
  listing: ListingWithCount,
  query: string,
): ReturnType<typeof rosterFilterFromQuery> =>
  rosterFilterFromQuery(listing, new URLSearchParams(query));

describe("the roster filter", () => {
  describe("the check-in filter", () => {
    test("shows everyone when nothing is asked for", () => {
      expect(filterFor(DAILY, "").activeFilter).toBe("all");
    });

    test("keeps those who checked in", () => {
      expect(filterFor(DAILY, "filter=in").activeFilter).toBe("in");
    });

    test("keeps those who have not", () => {
      expect(filterFor(DAILY, "filter=out").activeFilter).toBe("out");
    });

    test("shows everyone when the filter is not one we know", () => {
      expect(filterFor(DAILY, "filter=sideways").activeFilter).toBe("all");
    });

    test("shows everyone when the filter is empty", () => {
      expect(filterFor(DAILY, "filter=").activeFilter).toBe("all");
    });
  });

  describe("the date filter", () => {
    test("keeps a real date on a listing booked by the day", () => {
      expect(filterFor(DAILY, "date=2026-08-03").dateFilter).toBe("2026-08-03");
    });

    test("ignores a date that is not a date, rather than emptying the roster", () => {
      expect(filterFor(DAILY, "date=not-a-date").dateFilter).toBeNull();
    });

    test("ignores an empty date", () => {
      expect(filterFor(DAILY, "date=").dateFilter).toBeNull();
    });

    test("ignores a date on a listing not booked by the day", () => {
      expect(filterFor(STANDARD, "date=2026-08-03").dateFilter).toBeNull();
    });

    test("is absent when no date is asked for", () => {
      expect(filterFor(DAILY, "").dateFilter).toBeNull();
    });
  });

  test("reads both parts of the query together", () => {
    expect(filterFor(DAILY, "filter=in&date=2026-08-03")).toEqual({
      activeFilter: "in",
      dateFilter: "2026-08-03",
    });
  });
});
