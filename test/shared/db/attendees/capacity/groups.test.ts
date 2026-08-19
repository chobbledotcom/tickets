import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getDatelessGroupRemaining,
  getGroupPerDayRemaining,
  getGroupRemainingByGroupId,
  getGroupRemainingByListingId,
  getGroupStaticCapByGroupId,
  remainingByListingOverGroups,
} from "#db/attendees/capacity/groups.ts";
import { listingGroups } from "#db/groups.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookUnits } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "db > attendees > getDatelessGroupRemaining",
  { db: true },
  () => {
    test("includes only groups reachable from dateLessCap members", async () => {
      const standardGroup = await createTestGroup({
        maxAttendees: 5,
        name: "Standard Pool",
      });
      const dailyGroup = await createTestGroup({
        maxAttendees: 5,
        name: "Daily Pool",
      });
      const standard = await createTestListing({
        groupId: standardGroup.id,
        maxAttendees: 5,
      });
      const daily = await createDailyTestListing({
        groupId: dailyGroup.id,
        maxAttendees: 5,
      });
      const membership = await listingGroups.getIdsByKeys([
        standard.id,
        daily.id,
      ]);
      // A perDateCap member's group remaining is a per-date fact, so the
      // date-less read must include the standard member's group and exclude
      // the daily member's — not the other way round.
      const remaining = await getDatelessGroupRemaining(
        [standard, daily],
        membership,
      );
      expect(remaining.get(standardGroup.id)).toBe(5);
      expect(remaining.has(dailyGroup.id)).toBe(false);
    });

    test("returns static caps only for capped groups", async () => {
      const capped = await createTestGroup({
        maxAttendees: 5,
        name: "Capped Pool",
      });
      const uncapped = await createTestGroup({ name: "Uncapped Pool" });

      const capacities = await getGroupStaticCapByGroupId([
        capped.id,
        uncapped.id,
      ]);

      expect(capacities.get(capped.id)).toBe(5);
      expect(capacities.has(uncapped.id)).toBe(false);
      expect(capacities.size).toBe(1);
    });
  },
);

describeWithEnv(
  "db > attendees > group capacity by day",
  { db: true, triggers: true },
  () => {
    const day = (): string => addDays(todayInTz("UTC"), 2);

    test("answers for a single group capped at a single unit", async () => {
      const group = await createTestGroup({
        maxAttendees: 1,
        name: "Just one",
      });
      await createDailyTestListing({ groupId: group.id, name: "Only room" });

      const perDay = await getGroupPerDayRemaining([group.id], [day()]);

      expect(perDay.get(group.id)?.get(day())).toBe(1);
    });

    test("takes both the any-day bookings and that day's from the limit", async () => {
      const group = await createTestGroup({ maxAttendees: 10, name: "Mixed" });
      const anyDay = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Any day member",
      });
      const daily = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Dated member",
      });
      await bookUnits(anyDay.id, 3);
      await bookUnits(daily.id, 2, day());

      const perDay = await getGroupPerDayRemaining([group.id], [day()]);

      // 10 less the 3 booked on any day less the 2 booked on this day.
      expect(perDay.get(group.id)?.get(day())).toBe(5);
    });

    test("counts both kinds of member against the limit on a chosen day", async () => {
      const group = await createTestGroup({ maxAttendees: 10, name: "Both" });
      const anyDay = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Any day counted",
      });
      const daily = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Dated counted",
      });
      await bookUnits(anyDay.id, 3);
      await bookUnits(daily.id, 2, day());

      const remaining = await getGroupRemainingByGroupId([group.id], day());

      // 10 less the 3 booked whatever the day, less the 2 booked on this one.
      expect(remaining.get(group.id)).toBe(5);
    });

    test("reports nothing left, not one, for a full group", async () => {
      const group = await createTestGroup({ maxAttendees: 4, name: "Full" });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Filler",
      });
      await bookUnits(listing.id, 4);

      const remaining = await getGroupRemainingByGroupId([group.id]);

      expect(remaining.get(group.id)).toBe(0);
    });
  },
);

describeWithEnv(
  "db > attendees > group limits per listing",
  { db: true },
  () => {
    test("gives a listing the lowest limit of the groups it is in", () => {
      const membership = new Map([
        [1, [10, 20]],
        [2, []],
      ]);
      const byGroup = new Map([
        [10, 7],
        [20, 3],
      ]);

      const perListing = remainingByListingOverGroups(
        [1, 2],
        membership,
        byGroup,
      );

      expect(perListing.get(1)).toBe(3);
      // In no capped group at all, so it has no group limit to report.
      expect(perListing.has(2)).toBe(false);
    });

    test("leaves day-by-day listings out of a read with no date", async () => {
      const standardGroup = await createTestGroup({
        maxAttendees: 6,
        name: "Any day pool",
      });
      const dailyGroup = await createTestGroup({
        maxAttendees: 6,
        name: "Dated pool",
      });
      const standard = await createTestListing({
        groupId: standardGroup.id,
        maxAttendees: 6,
        name: "Any day",
      });
      const daily = await createDailyTestListing({
        groupId: dailyGroup.id,
        maxAttendees: 6,
        name: "Dated",
      });

      const remaining = await getGroupRemainingByListingId(
        [standard, daily],
        null,
      );

      expect(remaining.get(standard.id)).toBe(6);
      expect(remaining.has(daily.id)).toBe(false);
    });
  },
);
