/**
 * A multi-day booking is present on every day it covers, not only the day it
 * starts. The roster's day picker and its day filter both read it that way, so
 * day 2 of a stay can be selected and lists the stay.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { dateOptionsFor, filterByDate } from "#routes/admin/listings-view.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

const booking = (
  name: string,
  date: string | null,
  end_date: string | null,
): Attendee => testAttendee({ date, end_date, name });

const daily = (): ListingWithCount =>
  testListingWithCount({ listing_type: "daily" });

// A three-night stay, a single day inside it, and a day outside it.
const stay = booking("Priya", "2026-03-02", "2026-03-05");
const oneDay = booking("Rachel", "2026-03-03", "2026-03-04");
const later = booking("Marco", "2026-03-09", "2026-03-10");
const attendees = [stay, oneDay, later];

describe("the roster's view of a multi-day booking", () => {
  test("lists a stay on the first day it covers", () => {
    expect(filterByDate(attendees, "2026-03-02")).toEqual([stay]);
  });

  test("lists a stay on a middle day nobody starts on", () => {
    expect(filterByDate(attendees, "2026-03-04")).toEqual([stay]);
  });

  test("drops a stay on the day it ends, which it does not cover", () => {
    expect(filterByDate(attendees, "2026-03-05")).toEqual([]);
  });

  test("lists a stay alongside the single days inside it", () => {
    expect(filterByDate(attendees, "2026-03-03")).toEqual([stay, oneDay]);
  });

  test("keeps every attendee when no day is chosen", () => {
    expect(filterByDate(attendees, null)).toEqual(attendees);
  });

  test("offers every covered day, ascending and without repeats", () => {
    expect(dateOptionsFor(daily(), attendees).map((d) => d.value)).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-09",
    ]);
  });

  test("offers no days for a listing that is not booked by the day", () => {
    expect(dateOptionsFor(testListingWithCount({}), attendees)).toEqual([]);
  });

  test("skips a booking with no date at all", () => {
    const undated = booking("Sam", null, null);
    expect(dateOptionsFor(daily(), [undated])).toEqual([]);
    expect(filterByDate([undated], "2026-03-02")).toEqual([]);
  });
});
