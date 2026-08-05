/**
 * How long a booking is judged over on the gallery: a fixed-length stay is
 * judged over every day it takes up, a buyer-chosen-length one over a single
 * day, and a day the site is closed is offered to nobody.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import {
  enablePublicOrder,
  fetchAvailability,
  orderDate,
} from "#test/features/public/order/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookUnits } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import {
  createDailyTestListing,
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "server (public order) — how long a booking is judged over",
  { db: true, triggers: true },
  () => {
    enablePublicOrder();

    test("a buyer-chosen length is judged on its start day alone", async () => {
      const start = orderDate();
      // Two days long at most, but the buyer picks; the gallery cannot know
      // which, so it must judge the start day only.
      const flex = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 100, 2: 180 },
        durationDays: 2,
        maxAttendees: 1,
        name: "Flexible stay",
      });
      // The second day is full, which only matters to a two-day booking.
      await bookUnits(flex.id, 1, addDays(start, 1));

      const data = await fetchAvailability(`start_date=${start}`);

      expect(data.states[`listing:${flex.id}`]).toEqual({
        label: "",
        state: "available",
      });
    });

    test("a day the site is closed is offered to nobody", async () => {
      const start = orderDate();
      const daily = await createDailyTestListing({
        maxAttendees: 5,
        name: "Closed that day",
      });
      await createTestHoliday({
        endDate: start,
        name: "Closed",
        startDate: start,
      });

      const data = await fetchAvailability(`start_date=${start}`);

      expect(data.states[`listing:${daily.id}`]).toEqual({
        label: "Sold Out",
        state: "unavailable",
      });
    });

    test("a listing whose sale has ended cannot be added", async () => {
      // Plenty of room, but the sale closed yesterday: room alone is not
      // enough to offer it.
      const closed = await createTestListing({
        closesAt: pastCloseTime(),
        maxAttendees: 10,
        name: "Sale over",
      });

      const data = await fetchAvailability("");

      expect(data.states[`listing:${closed.id}`]?.state).not.toBe("available");
    });

    test("a package can be added on its own", async () => {
      const group = await createTestGroup({ isPackage: true, name: "Bundle" });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        name: "Bundle part",
        unitPrice: 0,
      });
      await setGroupPackageMembers(group.id, [
        { listingId: member.id, price: 500 },
      ]);

      const data = await fetchAvailability("");

      expect(data.states[`package:${group.id}`]).toEqual({
        label: "",
        state: "available",
      });
    });
  },
);
