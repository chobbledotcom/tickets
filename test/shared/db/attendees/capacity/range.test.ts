/**
 * Tests for `src/shared/db/attendees/capacity/range.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  dateToStartEnd,
  perDayLoads,
  spanLoadsOf,
} from "#db/attendees/capacity/range.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("spanLoadsOf", () => {
  test("reads the lines that overlap the span from its first day to its last", () => {
    expect(
      placed(
        spanLoadsOf(
          from(tables.listing_attendees).where({ listing_id: [4, 5] }),
          ["2026-03-03", "2026-03-01", "2026-03-02"],
          (line) => line.listing_id,
        ),
      ),
    ).toEqual({
      args: [4, 5, "2026-03-04T00:00:00.000Z", "2026-03-01T00:00:00Z"],
      sql: "SELECT listingAttendee.end_at AS end_at, listingAttendee.listing_id AS owner_id, listingAttendee.quantity AS quantity, listingAttendee.start_at AS start_at FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id IN (?, ?) AND listingAttendee.start_at < ? AND listingAttendee.end_at > ?",
    });
  });
});

describe("dateToStartEnd", () => {
  test("gives one day when the caller names no duration, or a duration of zero", () => {
    const oneDay = {
      endAt: "2026-03-02T00:00:00.000Z",
      startAt: "2026-03-01T00:00:00Z",
    };
    expect(dateToStartEnd("2026-03-01")).toEqual(oneDay);
    expect(dateToStartEnd("2026-03-01", 0)).toEqual(oneDay);
  });
});

describe("perDayLoads", () => {
  const row = (start_at: string, end_at: string, quantity: number) => ({
    end_at,
    quantity,
    start_at,
  });

  test("counts a line on each day that its range covers, and on no other day", () => {
    const loads = perDayLoads(
      [
        // Ends as the second of March starts, so it does not reach that day.
        row("2026-03-01T00:00:00Z", "2026-03-02T00:00:00.000Z", 1),
        row("2026-03-02T00:00:00Z", "2026-03-03T00:00:00.000Z", 2),
        // Starts as the second of March ends, so it does not reach that day.
        row("2026-03-03T00:00:00.000Z", "2026-03-04T00:00:00.000Z", 4),
        row("2026-03-01T00:00:00Z", "2026-03-04T00:00:00.000Z", 8),
      ],
      ["2026-03-02"],
    );
    expect([...loads]).toEqual([["2026-03-02", 10]]);
  });
});
