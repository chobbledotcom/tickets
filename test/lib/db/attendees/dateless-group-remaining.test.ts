import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDatelessGroupRemaining } from "#shared/db/attendees/capacity.ts";
import { getGroupIdsByListingIds } from "#shared/db/groups.ts";
import {
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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
      const membership = await getGroupIdsByListingIds([standard.id, daily.id]);
      // A perDateCap member's group remaining is a per-date fact, so the
      // date-less read must include the standard member's group and exclude
      // the daily member's — not the other way round.
      const remaining = await getDatelessGroupRemaining(
        [standard, daily].map(({ id, listing_type }) => ({
          id,
          listing_type,
        })),
        membership,
      );
      expect(remaining.has(standardGroup.id)).toBe(true);
      expect(remaining.has(dailyGroup.id)).toBe(false);
    });
  },
);
