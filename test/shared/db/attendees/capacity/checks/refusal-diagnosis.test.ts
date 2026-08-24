/**
 * refusedOrderUnfitListingIds names a refused order's culprit in two primary
 * round trips, whatever the order's size.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { LineBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { refusedOrderUnfitListingIds } from "#db/attendees/capacity/checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTwoListingsSharingOnePlace } from "#test-utils/db-helpers/groups.ts";
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

  test("asks each line alone when the lines sit on different days", async () => {
    const daily = await createDailyTestListing({
      maxAttendees: 1,
      maximumDaysAfter: 60,
    });
    const roomyDaily = await createDailyTestListing({
      maxAttendees: 10,
      maximumDaysAfter: 60,
    });
    const taken = await attendeesApi.createAttendeeAtomic({
      bookings: [{ date: DAY, listingId: daily.id, quantity: 1 }],
      email: "first@example.com",
      name: "First",
    });
    if (!taken.success) throw new Error("Setup: the day did not book");

    expect(
      await refusedOrderUnfitListingIds([
        line(roomyDaily.id, "2026-10-02"),
        line(daily.id, DAY),
      ]),
    ).toEqual([daily.id]);
  });

  test("a line whose listing is gone names nothing", async () => {
    expect(await refusedOrderUnfitListingIds([line(999_999)])).toEqual([]);
  });

  test("spends two database calls however long the order is", async () => {
    const lines: LineBooking[] = [];
    for (let index = 0; index < 8; index++) {
      const listing = await createTestListing({ maxAttendees: 10 });
      lines.push(line(listing.id));
    }

    expect(
      await countDatabaseCalls(2, () => refusedOrderUnfitListingIds(lines)),
    ).toBe(2);
  });
});
