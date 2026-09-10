/**
 * refusedOrderUnfitListingIds names a refused order's culprit in a bounded
 * number of primary round trips: one facts batch, then the order's prefixes
 * asked as one snapshot batch. A longer order narrows a bracket over stride
 * batches instead — those cases live in stride.test.ts.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { LineBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { refusedOrderUnfitListingIds } from "#db/attendees/capacity/refusal-diagnosis.ts";
import { execute } from "#db/client.ts";
import { enableQueryLog, runWithQueryLogContext } from "#db/query-log.ts";
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
import { awaitObservedProbe, DAY, line } from "./helpers.ts";

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

  /** A capped group with three roomy daily members, so only the shared group
   * cap can bind a cross-listing order. */
  const groupWithThreeDailyMembers = async (
    groupCap: number,
  ): Promise<[{ id: number }, { id: number }, { id: number }]> => {
    const group = await createTestGroup({ maxAttendees: groupCap });
    const member = (): Promise<{ id: number }> =>
      createDailyTestListing({ groupId: group.id, maxAttendees: 10 });
    return [await member(), await member(), await member()];
  };

  test("a multi-day dated line counts once toward the running total the undated guards read", async () => {
    // The trigger bumps the group's running total once per line, whatever the
    // line's day count. A two-day dated unit plus a date-less unit both write
    // against a cap of 2, so only the third line can be the culprit — the
    // undated clause must not count the dated unit once per occupied day.
    const [dated, first, second] = await groupWithThreeDailyMembers(2);

    expect(
      await refusedOrderUnfitListingIds([
        { date: DAY, durationDays: 2, listingId: dated.id, quantity: 1 },
        line(first.id),
        line(second.id),
      ]),
    ).toEqual([second.id]);
  });

  test("an undated guard does not see a dated line booked after the last date-less line", async () => {
    // The undated statements run before the dated one, and the dated
    // statement never sees the undated row because its range is null. So
    // [date-less 3, dated 3] both write against a cap of 5, and only a later
    // date-less line can abort the order.
    const [undated, dated, after] = await groupWithThreeDailyMembers(5);

    expect(
      await refusedOrderUnfitListingIds([
        line(undated.id, null, 3),
        line(dated.id, DAY, 3),
        line(after.id, null, 3),
      ]),
    ).toEqual([after.id]);
  });

  test("two date-less lines in one bucket read each other's totals once", async () => {
    // Each date-less statement reads the running total the earlier lines
    // left: one unit each against a cap of 2 fits line by line, so the whole
    // order fits. Adding the totals together would refuse it.
    const group = await createTestGroup({ maxAttendees: 2 });
    const first = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });
    const second = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });

    expect(
      await refusedOrderUnfitListingIds([line(first.id), line(second.id)]),
    ).toEqual([]);
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

  test("a cancellation after the probes' one snapshot still names the tipping line", async () => {
    // The facts batch and the prefix probes are the read's only two round
    // trips, and the probes share one snapshot. A cancellation observed after
    // that snapshot cannot change its answer, so the line that did not fit at
    // the snapshot is still named — no re-probe guard can veto it, because no
    // probe contradicts another any more.
    const group = await createTestGroup({ maxAttendees: 8 });
    const holder = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
    });
    await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: holder.id, quantity: 2 }],
      email: "holder@example.com",
      name: "Holder",
    });
    const lines: LineBooking[] = [];
    for (let index = 0; index < 8; index++) {
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
      });
      lines.push(line(listing.id));
    }

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      const diagnosis = refusedOrderUnfitListingIds(lines);
      // The probe batch's log entries appear together once the batch lands,
      // so waiting for the fits SQL to be observed means the snapshot is
      // already taken — a limit expiry must fail the test, not free the
      // room while the snapshot is still in flight and pass vacuously.
      await awaitObservedProbe();
      await execute("DELETE FROM listing_attendees WHERE listing_id = ?", [
        holder.id,
      ]);
      // Two held places plus seven lines tip the cap of eight, so the line
      // that did not fit at the snapshot is the seventh.
      expect(await diagnosis).toEqual([lines[6]!.listingId]);
    });
  });

  test("a long refused order is named in one facts batch and one snapshot batch", async () => {
    // The prefix probes share one snapshot, so the whole order's answer and
    // every prefix's answer come back together: two round trips for an order
    // small enough to sample every line, where the halving search needed
    // one request per probe.
    const lines = await eightLinesSharingOnePlace();
    expect(
      await countDatabaseCalls(2, () => refusedOrderUnfitListingIds(lines)),
    ).toBe(2);
  });

  test("an empty order names nothing", async () => {
    expect(await refusedOrderUnfitListingIds([])).toEqual([]);
  });

  test("a single unfit line names itself", async () => {
    const daily = await dailyTakenOnDay();
    expect(await refusedOrderUnfitListingIds([line(daily.id, DAY)])).toEqual([
      daily.id,
    ]);
  });
});
