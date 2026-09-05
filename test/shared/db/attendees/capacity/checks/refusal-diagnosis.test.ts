/**
 * refusedOrderUnfitListingIds names a refused order's culprit in a bounded
 * number of primary round trips: one facts batch, one whole-order probe, and
 * a binary search over the order's prefixes.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { LineBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { refusedOrderUnfitListingIds } from "#db/attendees/capacity/checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  createTwoListingsSharingOnePlace,
} from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const DAY = "2026-10-01";

const line = (
  listingId: number,
  date: string | null = null,
  quantity = 1,
): LineBooking => ({ date, durationDays: 1, listingId, quantity });

/** A one-place daily listing whose place on DAY is already taken. */
const dailyTakenOnDay = async (): Promise<{ id: number }> => {
  const daily = await createDailyTestListing({ maxAttendees: 1 });
  const taken = await attendeesApi.createAttendeeAtomic({
    bookings: [{ date: DAY, listingId: daily.id, quantity: 1 }],
    email: "first@example.com",
    name: "First",
  });
  if (!taken.success) throw new Error("Setup: the day did not book");
  return daily;
};

describeWithEnv("db > refusedOrderUnfitListingIds", { db: true }, () => {
  test("names the first line that does not fit on its predecessors", async () => {
    const { first, second } = await createTwoListingsSharingOnePlace();

    expect(
      await refusedOrderUnfitListingIds([line(first.id), line(second.id)]),
    ).toEqual([second.id]);
  });

  test("names nothing when every prefix fits", async () => {
    const roomy = await createTestListing({ maxAttendees: 10 });
    expect(await refusedOrderUnfitListingIds([line(roomy.id)])).toEqual([]);
  });

  test("dated lines on ONE shared day still get the cumulative check", async () => {
    // Each line fits alone; only the prefix check can name the second one.
    const { first, second } = await createTwoListingsSharingOnePlace("daily");

    expect(
      await refusedOrderUnfitListingIds([
        line(first.id, DAY),
        line(second.id, DAY),
      ]),
    ).toEqual([second.id]);
  });

  test("a day with room is judged on that day, not the listing's total", async () => {
    // A booking on another day fills the running total but not this day, so
    // the order's own day must reach the probes.
    const daily = await dailyTakenOnDay();

    expect(
      await refusedOrderUnfitListingIds([line(daily.id, "2026-10-05")]),
    ).toEqual([]);
  });

  test("an order whose FIRST line is the unfit one names it", async () => {
    const daily = await dailyTakenOnDay();
    const roomy = await createTestListing({ maxAttendees: 10 });

    expect(
      await refusedOrderUnfitListingIds([line(daily.id, DAY), line(roomy.id)]),
    ).toEqual([daily.id]);
  });

  test("a deep search lands exactly on the first line past the room", async () => {
    // Twelve lines share four places: prefixes one to four fit, five fails.
    // The halving must keep its fitting bound exact — an inflated bound
    // skips the probe that pins the fifth line and names the sixth.
    const shared = await createTestGroup({ maxAttendees: 4 });
    const lines: LineBooking[] = [];
    for (let index = 0; index < 12; index++) {
      const listing = await createTestListing({
        groupId: shared.id,
        maxAttendees: 10,
      });
      lines.push(line(listing.id));
    }

    expect(await refusedOrderUnfitListingIds(lines)).toEqual([
      lines[4]!.listingId,
    ]);
  });

  test("lines on one date of a multi-date order still get the cumulative check", async () => {
    // Two same-date lines share a one-place group: each fits alone, only the
    // prefix check can name the second one. A third line sits on another
    // date, so the order spans two dates.
    const { first, second } = await createTwoListingsSharingOnePlace("daily");
    const otherDay = await createDailyTestListing({ maxAttendees: 10 });

    expect(
      await refusedOrderUnfitListingIds([
        line(first.id, DAY),
        line(second.id, DAY),
        line(otherDay.id, "2026-10-05"),
      ]),
    ).toEqual([second.id]);
  });

  test("lines on different dates that share a running total get the cumulative check", async () => {
    // A standard listing's cap is one running total across all dates: 1
    // booked + 2 + 2 fits line by line but not line two on top of line one.
    const standard = await createTestListing({ maxAttendees: 3 });
    await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: standard.id, quantity: 1 }],
      email: "first@example.com",
      name: "First",
    });

    expect(
      await refusedOrderUnfitListingIds([
        line(standard.id, "2026-10-01", 2),
        line(standard.id, "2026-10-02", 2),
      ]),
    ).toEqual([standard.id]);
  });

  test("a daily listing's date-less line counts against its running total", async () => {
    // Two booked units sit in the running total from another day. The dated
    // line fits the day; the date-less line then tips the total over. The
    // diagnosis must see both demands in one bucket.
    const daily = await createDailyTestListing({ maxAttendees: 3 });
    await attendeesApi.createAttendeeAtomic({
      bookings: [{ date: "2026-10-05", listingId: daily.id, quantity: 2 }],
      email: "first@example.com",
      name: "First",
    });

    expect(
      await refusedOrderUnfitListingIds([
        line(daily.id, DAY, 1),
        line(daily.id, null, 1),
      ]),
    ).toEqual([daily.id]);
  });

  test("an order that fits again costs two calls across several dates", async () => {
    const lines: LineBooking[] = [];
    for (let index = 0; index < 8; index++) {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      lines.push(line(listing.id, index % 2 ? DAY : "2026-10-05"));
    }

    expect(
      await countDatabaseCalls(2, () => refusedOrderUnfitListingIds(lines)),
    ).toBe(2);
  });

  test("a line whose listing is gone names nothing", async () => {
    expect(await refusedOrderUnfitListingIds([line(999_999)])).toEqual([]);
  });

  test("an order that fits again costs two calls however long it is", async () => {
    const lines: LineBooking[] = [];
    for (let index = 0; index < 8; index++) {
      const listing = await createTestListing({ maxAttendees: 10 });
      lines.push(line(listing.id));
    }

    expect(
      await countDatabaseCalls(2, () => refusedOrderUnfitListingIds(lines)),
    ).toBe(2);
  });

  /** Eight roomy lines whose shared group has one place: only the first
   * fits, so the search must walk down to the second line. */
  const eightLinesSharingOnePlace = async (): Promise<LineBooking[]> => {
    const shared = await createTestGroup({ maxAttendees: 1 });
    const lines: LineBooking[] = [];
    for (let index = 0; index < 8; index++) {
      const listing = await createTestListing({
        groupId: shared.id,
        maxAttendees: 10,
      });
      lines.push(line(listing.id));
    }
    return lines;
  };

  test("a long refused order still names the line that tips the limit", async () => {
    const lines = await eightLinesSharingOnePlace();
    expect(await refusedOrderUnfitListingIds(lines)).toEqual([
      lines[1]!.listingId,
    ]);
  });

  test("a long refused order is named within a logarithmic call count", async () => {
    // The facts batch plus the whole-order probe plus three halving probes
    // is five calls — one per prefix would be nine.
    const lines = await eightLinesSharingOnePlace();
    expect(
      await countDatabaseCalls(5, () => refusedOrderUnfitListingIds(lines)),
    ).toBe(5);
  });
});
