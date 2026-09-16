/**
 * Reading a visitor's choices for an attendee list from its query string.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  readListState as read,
  testBrowserListSetup,
  testRosterListSetup,
} from "#test-utils/attendee-list.ts";

describe("reading the choices from a query string", () => {
  describe("the listing choice", () => {
    test("keeps a chosen listing the setup offers", () => {
      expect(read(testBrowserListSetup(), "listing=7").listingId).toBe(7);
    });

    test("falls back to all listings for an unknown listing", () => {
      expect(
        read(testBrowserListSetup(), "listing=999999").listingId,
      ).toBeNull();
    });

    test("falls back to all listings for a malformed listing", () => {
      expect(read(testBrowserListSetup(), "listing=7x").listingId).toBeNull();
    });

    test("is absent when nothing is chosen", () => {
      expect(read(testBrowserListSetup(), "").listingId).toBeNull();
    });
  });

  describe("the type choice", () => {
    test("keeps a known type", () => {
      expect(read(testBrowserListSetup(), "type=daily").type).toBe("daily");
    });

    test("treats an unknown type as all", () => {
      expect(read(testBrowserListSetup(), "type=bogus").type).toBe("all");
    });

    test("stays all on a list without the type filter", () => {
      expect(read(testRosterListSetup(), "type=daily").type).toBe("all");
    });
  });

  describe("the sort choice", () => {
    test("keeps a known sort", () => {
      expect(read(testBrowserListSetup(), "sort=oldest").sort).toBe("oldest");
    });

    test("falls back to the list's default for a sort we don't know", () => {
      expect(read(testBrowserListSetup(), "sort=sideways").sort).toBe("newest");
    });

    test("falls back to the list's own order when that is the default", () => {
      expect(read(testRosterListSetup(), "sort=sideways").sort).toBeNull();
    });

    test("a roster can still choose a registration order", () => {
      expect(read(testRosterListSetup(), "sort=newest").sort).toBe("newest");
    });
  });

  describe("the check-in choice", () => {
    test("keeps checked-in and checked-out", () => {
      expect(read(testRosterListSetup(), "filter=in").checkin).toBe("in");
      expect(read(testRosterListSetup(), "filter=out").checkin).toBe("out");
    });

    test("shows everyone when the filter is not one we know", () => {
      expect(read(testRosterListSetup(), "filter=sideways").checkin).toBe(
        "all",
      );
    });

    test("shows everyone when the filter is empty", () => {
      expect(read(testRosterListSetup(), "filter=").checkin).toBe("all");
    });

    test("stays all on a list without the check-in filter", () => {
      expect(read(testBrowserListSetup(), "filter=in").checkin).toBe("all");
    });
  });

  describe("the day choice", () => {
    test("keeps a real date on a list with the day filter", () => {
      expect(read(testRosterListSetup(), "date=2026-08-03").date).toBe(
        "2026-08-03",
      );
    });

    test("ignores a date that is not a date, rather than emptying the list", () => {
      expect(read(testRosterListSetup(), "date=not-a-date").date).toBeNull();
    });

    test("ignores an empty date", () => {
      expect(read(testRosterListSetup(), "date=").date).toBeNull();
    });

    test("keeps a well-formed day even when the dropdown does not offer it", () => {
      // A day nobody booked filters to an empty list — the honest answer for
      // that day — and the CSV export reads days with an empty dropdown list.
      expect(read(testRosterListSetup(), "date=2030-01-01").date).toBe(
        "2030-01-01",
      );
    });

    test("ignores a date on a list without the day filter", () => {
      expect(read(testBrowserListSetup(), "date=2026-08-03").date).toBeNull();
    });
  });

  describe("the page choice", () => {
    test("keeps a page number", () => {
      expect(read(testBrowserListSetup(), "page=3").page).toBe(3);
    });

    test("treats a malformed page as the first page", () => {
      expect(read(testBrowserListSetup(), "page=abc").page).toBe(0);
    });

    test("treats a non-positive page as the first page", () => {
      expect(read(testBrowserListSetup(), "page=0").page).toBe(0);
    });

    test("stays on the first page for a list that is not paged", () => {
      expect(read(testRosterListSetup(), "page=3").page).toBe(0);
    });
  });

  test("reads every part of the query together", () => {
    expect(
      read(testRosterListSetup(), "filter=in&date=2026-08-03&sort=oldest"),
    ).toEqual({
      checkin: "in",
      date: "2026-08-03",
      listingId: null,
      page: 0,
      sort: "oldest",
      type: "all",
    });
  });
});
