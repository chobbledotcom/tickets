import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getDatelessGroupRemaining,
  getGroupStaticCapByGroupId,
} from "#shared/db/attendees/capacity/groups.ts";
import { getGroupIdsByListingIds } from "#shared/db/groups.ts";
import { updateListingAggregateValues } from "#shared/db/listings/aggregates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const remainingFor = async (
  members: Parameters<typeof getDatelessGroupRemaining>[0],
) =>
  getDatelessGroupRemaining(
    members,
    await getGroupIdsByListingIds(members.map(({ id }) => id)),
  );

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
      // A perDateCap member's group remaining is a per-date fact, so the
      // date-less read must include the standard member's group and exclude
      // the daily member's — not the other way round.
      const remaining = await remainingFor([standard, daily]);
      expect(remaining.has(standardGroup.id)).toBe(true);
      expect(remaining.has(dailyGroup.id)).toBe(false);
    });

    test("ignores per-date booked totals in a mixed group", async () => {
      const group = await createTestGroup({
        maxAttendees: 5,
        name: "Mixed Pool",
      });
      const standard = await createTestListing({ groupId: group.id });
      const daily = await createDailyTestListing({ groupId: group.id });
      await updateListingAggregateValues(daily.id, {
        booked_quantity: 4,
        tickets_count: 1,
      });
      const remaining = await remainingFor([standard, daily]);

      expect(remaining.get(group.id)).toBe(5);
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
