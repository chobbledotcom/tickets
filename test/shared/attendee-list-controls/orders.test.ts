/**
 * The row orders an attendee list uses, and the sort picklist that guards them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeListOrder,
  compareOptionalDates,
  inDateAndNameOrder,
  inRegistrationOrder,
  isAttendeeSort,
} from "#shared/attendee-list-controls.ts";

import { checkBothArms } from "#test-utils/picklist-guard.ts";

describe("registration order", () => {
  const rows = [{ id: 2 }, { id: 9 }, { id: 5 }];

  test("newest first puts the highest id at the top", () => {
    expect(inRegistrationOrder("newest")(rows).map((r) => r.id)).toEqual([
      9, 5, 2,
    ]);
  });

  test("oldest first puts the lowest id at the top", () => {
    expect(inRegistrationOrder("oldest")(rows).map((r) => r.id)).toEqual([
      2, 5, 9,
    ]);
  });

  test("leaves the given rows untouched", () => {
    inRegistrationOrder("newest")(rows);
    expect(rows.map((r) => r.id)).toEqual([2, 9, 5]);
  });
});

describe("the booked-date comparison", () => {
  test("orders booked dates ascending", () => {
    expect(compareOptionalDates("2026-08-01", "2026-08-02")).toBeLessThan(0);
    expect(compareOptionalDates("2026-08-02", "2026-08-01")).toBeGreaterThan(0);
    expect(compareOptionalDates("2026-08-01", "2026-08-01")).toBe(0);
  });

  test("sorts a missing date after the booked ones", () => {
    expect(compareOptionalDates(null, "2026-08-01")).toBeGreaterThan(0);
    expect(compareOptionalDates("2026-08-01", null)).toBeLessThan(0);
    expect(compareOptionalDates(null, null)).toBe(0);
  });
});

describe("the table's own date-and-name order", () => {
  const row = (
    id: number,
    date: string | null,
    name: string,
  ): { date: string | null; id: number; name: string } => ({ date, id, name });

  test("orders by booked date, then name, then id", () => {
    const rows = [
      row(3, "2026-08-02", "Later"),
      row(1, "2026-08-01", "Beta"),
      row(2, "2026-08-01", "Alpha"),
    ];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([2, 1, 3]);
  });

  test("sorts a booking with no date after the dated ones", () => {
    const rows = [row(1, null, "Undated"), row(2, "2026-08-01", "Dated")];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  test("breaks equal dates and names by registration id", () => {
    const rows = [
      row(5, "2026-08-01", "Same Name"),
      row(4, "2026-08-01", "Same Name"),
      row(6, "2026-08-01", "Same Name"),
    ];
    expect(inDateAndNameOrder(rows).map((r) => r.id)).toEqual([4, 5, 6]);
  });

  test("leaves the given rows untouched", () => {
    const rows = [row(2, null, "B"), row(1, null, "A")];
    inDateAndNameOrder(rows);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("a roster's row order", () => {
  const rows = [
    { date: null, id: 1, name: "Mid" },
    { date: null, id: 2, name: "Alpha" },
  ];

  test("no sort chosen: the table's own date-and-name order", () => {
    expect(attendeeListOrder(null)(rows).map((r) => r.name)).toEqual([
      "Alpha",
      "Mid",
    ]);
  });

  test("a chosen registration order replaces the default", () => {
    // Newest first: the highest id (Alpha) on top.
    expect(attendeeListOrder("newest")(rows).map((r) => r.name)).toEqual([
      "Alpha",
      "Mid",
    ]);
    expect(attendeeListOrder("oldest")(rows).map((r) => r.name)).toEqual([
      "Mid",
      "Alpha",
    ]);
  });
});

describe("AttendeeSort picklist", () => {
  checkBothArms(
    isAttendeeSort,
    ["newest", "oldest"],
    ["", "new", "old", "recent", "Newest"],
  );
});
