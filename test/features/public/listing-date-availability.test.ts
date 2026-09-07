/**
 * The `/listings?date=` filter reads one capacity snapshot for the union of
 * daily cards and package members: adding packages must not add database
 * round trips, and a fully booked member makes only its own package sold out.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  bookableStartDates,
  createDailyTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const CAPPED_DAILY_PACKAGES = 17;

/** One visible capped package with one daily member. */
const makePackage = async (index: number) => {
  const group = await createTestGroup({
    isPackage: true,
    maxAttendees: 5,
    name: `Dated Package ${index}`,
  });
  const member = await createDailyTestListing({
    groupId: group.id,
    maxAttendees: 5,
    maxQuantity: 5,
    name: `Dated Member ${index}`,
  });
  return { group, member };
};

/** Database round trips one date-filtered /listings request makes, with
 * `packageCount` capped daily packages already in the database. `offset`
 * keeps fixture names unique across the test's two runs. */
const dateFilterQueries = async (
  packageCount: number,
  offset = 0,
): Promise<readonly string[]> => {
  for (let index = 0; index < packageCount; index++) {
    await makePackage(offset + index);
  }
  const queries: string[] = [];
  // One warm-up absorbs first-request maintenance work, which races wall
  // clock rather than tracking package count.
  await (await handleRequest(mockRequest("/listings"))).body?.cancel();
  const restore = recordQueries(queries);
  try {
    const response = await handleRequest(
      mockRequest("/listings?date=2030-01-01"),
    );
    expect(response.status).toBe(200);
  } finally {
    restore();
  }
  return queries;
};

/** The capacity reads that used to repeat per package: every statement the
 * page reads `listing_attendees` with (the per-listing day loads and the
 * per-group day loads). */
const capacityReads = (queries: readonly string[]): number =>
  queries.filter(
    (sql) => /^SELECT/.test(sql) && sql.includes("listing_attendees"),
  ).length;

describeWithEnv(
  "the date-filtered listings page",
  { db: true, triggers: true },
  () => {
    test("a page with no daily listings needs no date read", async () => {
      const { loadDailyDateAvailability } = await import(
        "#routes/public/listing-date-availability.ts"
      );
      // A daily listing the buyer cannot start on the request date is
      // unavailable; with none there is nothing to judge.
      const listing = await createDailyTestListing();
      const date = (await bookableStartDates(listing.id))[0]!;
      const empty = await loadDailyDateAvailability([], date, []);

      expect(empty).toEqual(new Set());
    });

    test("adding daily packages does not add capacity reads or break the budget", async () => {
      await enablePublicSite();
      const many = await dateFilterQueries(CAPPED_DAILY_PACKAGES);
      const one = await dateFilterQueries(1, CAPPED_DAILY_PACKAGES);

      expect(capacityReads(many)).toBe(capacityReads(one));
      expect(many.length).toBeLessThanOrEqual(40);
    });

    test("a fully booked daily member makes only its package sold out", async () => {
      await enablePublicSite();
      const { member } = await makePackage(0);
      const { member: otherMember } = await makePackage(1);
      const date = (await bookableStartDates(member.id))[0]!;
      await bookAttendee(member, {
        date,
        email: "full@example.com",
        quantity: 5,
      });

      const html = await (
        await handleRequest(mockRequest(`/listings?date=${date}`))
      ).text();

      expect(html).toContain("Sold Out");
      expect(html).not.toContain(`/ticket/${member.slug}`);
      expect(html).toContain(`/ticket/${otherMember.slug}`);
    });
  },
);
