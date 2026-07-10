/**
 * Direct tests for checkGroupCapAfterDurationChange — the sweep that, after a
 * listing's duration changes, finds the earliest day where the group's
 * bookings now exceed the group cap.
 *
 * Bookings are made while the group has no limit (a booking-time cap check
 * would reject them); the cap is then set and the sweep is asked whether the
 * recomputed ranges still fit — exactly the order the duration-change flow
 * runs in.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  checkGroupCapAfterDurationChange,
  recomputeListingBookingRanges,
} from "#shared/db/attendees/update.ts";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const D1 = "2026-09-01";
const D2 = "2026-09-02";
const D3 = "2026-09-03";

/** Give the group its real cap only after the bookings exist, mirroring how a
 * duration change can push already-accepted bookings over the limit. */
const setGroupCap = async (groupId: number, cap: number): Promise<void> => {
  await getDb().execute({
    args: [cap, groupId],
    sql: "UPDATE groups SET max_attendees = ? WHERE id = ?",
  });
};

/** A capless group holding one daily listing. */
const groupWithDaily = async () => {
  const group = await createTestGroup({ maxAttendees: 0 });
  const listing = await createDailyTestListing({ groupId: group.id });
  return { group, listing };
};

/** A capless group holding two daily listings. */
const groupWithDailyPair = async () => {
  const { group, listing } = await groupWithDaily();
  const sibling = await createDailyTestListing({ groupId: group.id });
  return { group, listing, sibling };
};

/** A capless group holding one standard (non-daily) and one daily listing. */
const groupWithStandardAndDaily = async () => {
  const group = await createTestGroup({ maxAttendees: 0 });
  const standard = await createTestListing({
    groupId: group.id,
    maxAttendees: 100,
  });
  const daily = await createDailyTestListing({ groupId: group.id });
  return { daily, group, standard };
};

describeWithEnv("db > group cap after duration change", { db: true }, () => {
  test("reports the earliest over-capacity day after a duration change", async () => {
    const { group, listing, sibling } = await groupWithDailyPair();
    await bookAttendee(listing, { date: D1, quantity: 6 });
    await bookAttendee(sibling, { date: D2, quantity: 6 });
    await bookAttendee(sibling, { date: D3, quantity: 6 });

    // Extending the listing to 3 days makes it span D1..D3; both sibling days
    // now hold 12 > 10 — the sweep must name the EARLIEST one.
    await recomputeListingBookingRanges(listing.id, 3);
    await setGroupCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(listing.id, group.id)).toBe(
      D2,
    );
  });

  test("returns null when every day fits exactly at the cap", async () => {
    // A non-daily sibling counts on EVERY day: base 4 + the daily 6 = 10, the
    // cap exactly — at the limit is not over it.
    const { daily, group, standard } = await groupWithStandardAndDaily();
    await bookAttendee(standard, { quantity: 4 });
    await bookAttendee(daily, { date: D1, quantity: 6 });
    await setGroupCap(group.id, 10);

    expect(
      await checkGroupCapAfterDurationChange(daily.id, group.id),
    ).toBeNull();
  });

  test("a non-daily sibling's quantity pushes a booked day over the cap", async () => {
    const { daily, group, standard } = await groupWithStandardAndDaily();
    await bookAttendee(standard, { quantity: 6 });
    await bookAttendee(daily, { date: D1, quantity: 6 });
    await setGroupCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(daily.id, group.id)).toBe(D1);
  });

  test("back-to-back bookings at the cap fit (occupancy falls when a range ends)", async () => {
    // [D1, D2) then [D2, D3): the first booking's quantity must stop counting
    // the day it ends, or the second day would falsely read 12.
    const { group, listing } = await groupWithDaily();
    await bookAttendee(listing, { date: D1, quantity: 6 });
    await bookAttendee(listing, { date: D2, quantity: 6 });
    await setGroupCap(group.id, 6);

    expect(
      await checkGroupCapAfterDurationChange(listing.id, group.id),
    ).toBeNull();
  });

  test("ignores legacy rows with a NULL range on a daily listing", async () => {
    const { group, listing } = await groupWithDaily();
    await bookAttendee(listing, { date: D1, quantity: 6 });
    // Two pre-daily legacy shapes: a row with no range at all, and a
    // half-backfilled row that kept only its end. Neither may count (or
    // crash the sweep's date slicing).
    await bookAttendee(listing, { date: D2, quantity: 9 });
    await bookAttendee(listing, { date: D3, quantity: 9 });
    await getDb().execute({
      args: [listing.id, `${D2}T00:00:00Z`],
      sql: "UPDATE listing_attendees SET start_at = NULL, end_at = NULL WHERE listing_id = ? AND start_at = ?",
    });
    await getDb().execute({
      args: [listing.id, `${D3}T00:00:00Z`],
      sql: "UPDATE listing_attendees SET start_at = NULL WHERE listing_id = ? AND start_at = ?",
    });
    await setGroupCap(group.id, 10);

    expect(
      await checkGroupCapAfterDurationChange(listing.id, group.id),
    ).toBeNull();
  });

  test("a group with no limit never reports an overflow", async () => {
    const { group, listing } = await groupWithDaily();
    await bookAttendee(listing, { date: D1, quantity: 6 });

    expect(
      await checkGroupCapAfterDurationChange(listing.id, group.id),
    ).toBeNull();
  });

  test("a cap of one reports the over-booked day", async () => {
    const { group, listing } = await groupWithDaily();
    await bookAttendee(listing, { date: D1, quantity: 2 });
    await setGroupCap(group.id, 1);

    expect(await checkGroupCapAfterDurationChange(listing.id, group.id)).toBe(
      D1,
    );
  });

  test("an overflow on days this listing does not cover is not reported", async () => {
    // The sibling's day is heavily over the cap, but this listing's bookings
    // never touch it, so this listing's duration change cannot be blamed.
    const { group, listing } = await groupWithDaily();
    const sibling = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(listing, { date: D1, quantity: 2 });
    await bookAttendee(sibling, { date: "2026-09-05", quantity: 20 });
    await setGroupCap(group.id, 10);

    expect(
      await checkGroupCapAfterDurationChange(listing.id, group.id),
    ).toBeNull();
  });

  test("finds an overflow inside a later range once an earlier range has ended", async () => {
    // Two ranges on the checked listing: [09-01, 09-05) and [09-05, 09-09)
    // after a 4-day recompute. The sibling's 09-06 booking overflows a day
    // covered only by the SECOND range — the sweep must keep extending the
    // "inside this listing's booked days" horizon range by range.
    const { group, listing, sibling } = await groupWithDailyPair();
    await bookAttendee(listing, { date: D1, quantity: 2 });
    await bookAttendee(listing, { date: "2026-09-05", quantity: 2 });
    await bookAttendee(sibling, { date: "2026-09-06", quantity: 9 });
    await recomputeListingBookingRanges(listing.id, 4);
    await setGroupCap(group.id, 10);

    expect(await checkGroupCapAfterDurationChange(listing.id, group.id)).toBe(
      "2026-09-06",
    );
  });
});
