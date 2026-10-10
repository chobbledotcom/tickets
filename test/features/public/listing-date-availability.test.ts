/**
 * The `/listings?date=` filter reads one capacity snapshot for the union of
 * daily cards and package members: adding packages must not add database
 * round trips, and a fully booked member makes only its own package sold out.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import {
  listingChildren,
  setListingChildrenWithPackageCheckTx,
} from "#db/listing-parents.ts";
import { handleRequest } from "#routes";
import { loadDailyDateAvailability } from "#routes/public/listing-date-availability.ts";
import { getBookableStartDates } from "#shared/dates.ts";
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
import type { ListingWithCount } from "#types";

const CAPPED_DAILY_PACKAGES = 17;

/** Links `child` under `parent`, books two of its places on the second day
 *  of `parent`'s span, and answers the parent's availability on the first
 *  day. The short second day is the fixture the inherited-span tests read. */
const judgeParentWithShortSecondDay = async (
  parent: ListingWithCount,
  child: ListingWithCount,
): Promise<ReadonlySet<number>> => {
  await withTransaction((tx) =>
    setListingChildrenWithPackageCheckTx(tx, parent.id, [child.id]),
  );
  const [date, second] = (await bookableStartDates(parent.id)) as [
    string,
    string,
  ];
  await bookAttendee(child, {
    date: second,
    email: "short-second-day@example.com",
    quantity: 2,
  });
  return loadDailyDateAvailability([parent], date, []);
};

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

    test("a customisable card is judged per chosen day, a fixed one per whole booking", async () => {
      // Both listings store a 3-day duration. The customisable one is judged
      // over the chosen start day alone, so a booking on its SECOND bookable
      // day leaves the first day bookable; the fixed one is judged over its
      // whole 3-day booking, so one booking starting on the first day sells
      // that start out.
      const customisable = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        maxAttendees: 1,
        maxQuantity: 1,
        name: "Pick A Day",
      });
      const fixed = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 1,
        maxQuantity: 1,
        name: "Three Day Block",
      });
      const starts = await bookableStartDates(fixed.id);
      const [date, next] = starts as [string, string];
      await bookAttendee(customisable, {
        date: next,
        email: "next-day@example.com",
        quantity: 1,
      });
      await bookAttendee(fixed, {
        date,
        email: "first-day@example.com",
        quantity: 1,
      });

      const soldOut = await loadDailyDateAvailability(
        [customisable, fixed],
        date,
        [],
      );

      expect(soldOut).toEqual(new Set([fixed.id]));
    });

    test("a customisable child is judged over the fixed parent's span", async () => {
      // The parent books three days from its start date, and the fold
      // consumes the customisable child on every one of those days. The
      // child's own card reads one day, so judging it by its card span
      // lets a date with a short second day advertise a fold every
      // submission rejects.
      const parent = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 3,
        name: "Three Day Bundle",
      });
      const child = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        maxAttendees: 4,
        maxQuantity: 4,
        name: "Flexible Add-on",
      });

      const soldOut = await judgeParentWithShortSecondDay(parent, child);

      expect(soldOut).toEqual(new Set([parent.id]));
    });

    test("a fixed child is judged over each compatible day count of a customisable parent", async () => {
      // The parent's form offers one- and three-day bookings, and its fixed
      // three-day child can only ride the three-day count. Two of the
      // child's four places are taken on the span's second day, so the
      // three-day count cannot serve the parent's minimum of three — the
      // one-day count the child cannot ride must not answer for it.
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 3,
        name: "Pick A Span",
      });
      const child = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 4,
        maxQuantity: 4,
        name: "Fixed Three Day",
      });

      const soldOut = await judgeParentWithShortSecondDay(parent, child);

      expect(soldOut).toEqual(new Set([parent.id]));
    });

    test("a parent whose children share no day count reads sold out", async () => {
      // The form books one count: the one-day child and the three-day child
      // cannot ride the same booking, so no offered count serves the fold
      // and the parent's dates read sold out.
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 1,
        name: "Mixed Spans",
      });
      const oneDay = await createDailyTestListing({
        durationDays: 1,
        maxAttendees: 2,
        maxQuantity: 2,
        name: "One Day Add-on",
      });
      const threeDay = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 2,
        maxQuantity: 2,
        name: "Three Day Add-on",
      });
      await withTransaction((tx) =>
        setListingChildrenWithPackageCheckTx(tx, parent.id, [
          oneDay.id,
          threeDay.id,
        ]),
      );
      const [date] = (await bookableStartDates(parent.id)) as [string];

      const soldOut = await loadDailyDateAvailability([parent], date, []);

      expect(soldOut).toEqual(new Set([parent.id]));
    });

    test("a date with places left below the listing's minimum is unavailable", async () => {
      // Two places remain on the date, but the listing sells at least three
      // per purchase — no valid purchase can use the date.
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 3,
        name: "Batches Only",
      });
      const date = (await bookableStartDates(listing.id))[0]!;
      await bookAttendee(listing, {
        date,
        email: "two-left@example.com",
        quantity: 3,
      });

      const soldOut = await loadDailyDateAvailability([listing], date, []);

      expect(soldOut).toEqual(new Set([listing.id]));
    });

    test("a daily parent is unavailable when its children cannot serve the minimum", async () => {
      // The parent sells at least 3 per purchase and has places of its own,
      // but its required child holds only 2 on the date: no fold of three
      // child tickets can serve the minimum, so the parent's date is as
      // unavailable as an empty row.
      const parent = await createDailyTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 3,
        name: "Batched base",
      });
      const child = await createDailyTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
        name: "Small add-on",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      const date = (await bookableStartDates(parent.id))[0]!;
      await bookAttendee(child, {
        date,
        email: "two-left@example.com",
        quantity: 3,
      });

      const soldOut = await loadDailyDateAvailability(
        [parent, child],
        date,
        [],
      );

      // The date is bookable for both rows: only the parent's combined
      // minimum puts it in the sold-out set.
      expect(getBookableStartDates(parent, []).includes(date)).toBe(true);
      expect(getBookableStartDates(child, []).includes(date)).toBe(true);
      expect(soldOut).toEqual(new Set([parent.id]));
    });

    test("a hidden required child's own capacity counts on the date", async () => {
      // The parent sells at least 3 per purchase and its required child is a
      // hidden listing: no public card, so only the snapshot can know the
      // child holds four places. The parent must read available, not sold out
      // through a zero capacity the missing row implied.
      const parent = await createDailyTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
        minQuantity: 3,
        name: "Hidden child base",
      });
      const child = await createDailyTestListing({
        hidden: true,
        maxAttendees: 4,
        maxQuantity: 4,
        name: "Secret add-on",
      });
      await listingChildren.setIds(parent.id, [child.id]);
      const date = (await bookableStartDates(parent.id))[0]!;

      const soldOut = await loadDailyDateAvailability([parent], date, []);

      expect(soldOut).toEqual(new Set());
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
