import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  formatAddressInline,
  sortAttendeeRows,
} from "#templates/attendee-table.tsx";
import { testAttendee } from "#test-utils/factories.ts";
import { attendeeTableSuite, makeRow, namedListingRow } from "./shared.ts";

attendeeTableSuite(() => {
  describe("sortAttendeeRows", () => {
    test("sorts by listing date with missing dates last", () => {
      const rows = [
        namedListingRow("A", testAttendee({ date: null, id: 1 })),
        namedListingRow("A", testAttendee({ date: "2026-03-01", id: 2 })),
        namedListingRow("A", testAttendee({ date: "2026-01-15", id: 3 })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        3, 2, 1,
      ]);
    });

    test("sorts by first listing name when dates match", () => {
      const rows = [
        namedListingRow("Zebra", testAttendee({ date: "2026-03-01", id: 1 })),
        namedListingRow("Alpha", testAttendee({ date: "2026-03-01", id: 2 })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts by attendee name when date and listing match", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 1, name: "Zara" })),
        namedListingRow("Gala", testAttendee({ id: 2, name: "Alice" })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts by id when all other fields match", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 5, name: "Sam" })),
        namedListingRow("Gala", testAttendee({ id: 2, name: "Sam" })),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 5,
      ]);
    });

    test("applies the complete multi-key order", () => {
      const rows = [
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-02-01", id: 1, name: "Bob" }),
        ),
        namedListingRow(
          "Gala",
          testAttendee({ date: null, id: 2, name: "Alice" }),
        ),
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-01-15", id: 3, name: "Alice" }),
        ),
        namedListingRow(
          "Concert",
          testAttendee({ date: "2026-02-01", id: 4, name: "Alice" }),
        ),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        3, 4, 1, 2,
      ]);
    });

    test("sorts a listing-less row before a named listing", () => {
      const rows = [
        namedListingRow("Gala", testAttendee({ id: 1 })),
        makeRow({ attendee: testAttendee({ id: 2 }), listings: [] }),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("sorts listing-less rows by attendee name", () => {
      const rows = [
        makeRow({
          attendee: testAttendee({ id: 1, name: "Zara" }),
          listings: [],
        }),
        makeRow({
          attendee: testAttendee({ id: 2, name: "Alice" }),
          listings: [],
        }),
      ];
      expect(sortAttendeeRows(rows).map((row) => row.attendee.id)).toEqual([
        2, 1,
      ]);
    });

    test("does not mutate the input", () => {
      const rows = [
        namedListingRow("B", testAttendee({ id: 2 })),
        namedListingRow("A", testAttendee({ id: 1 })),
      ];
      sortAttendeeRows(rows);
      expect(rows.map((row) => row.attendee.id)).toEqual([2, 1]);
    });
  });

  describe("formatAddressInline", () => {
    test("returns an empty string for empty input", () => {
      expect(formatAddressInline("")).toBe("");
    });

    test("joins lines with commas", () => {
      expect(formatAddressInline("123 Main St\nApt 4\nNew York")).toBe(
        "123 Main St, Apt 4, New York",
      );
    });

    test("does not duplicate an existing trailing comma", () => {
      expect(formatAddressInline("123 Main St,\nNew York")).toBe(
        "123 Main St, New York",
      );
    });

    test("trims each line", () => {
      expect(formatAddressInline("  123 Main St  \n  New York  ")).toBe(
        "123 Main St, New York",
      );
    });

    test("removes blank lines", () => {
      expect(formatAddressInline("123 Main St\n\nNew York")).toBe(
        "123 Main St, New York",
      );
    });
  });
});
