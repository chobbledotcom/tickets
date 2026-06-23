import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingRemainingForRange } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getListingWithCount,
  updateListingAggregateValues,
} from "#shared/db/listings.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  bookAttendee,
  createDailyTestListing,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

/** Fetch the listing-with-count row the helper accepts as input. */
const row = async (id: number): Promise<ListingWithCount> =>
  (await getListingWithCount(id))!;

/** Remaining units for a single listing over a date + duration. */
const remaining = async (
  id: number,
  date: string | null,
  durationDays = 1,
): Promise<number> => {
  const map = await getListingRemainingForRange(
    [await row(id)],
    date,
    durationDays,
  );
  return map.get(id)!;
};

/** Overbook a listing by lowering its cap below what is already booked,
 * bypassing the capacity guard that would block it during booking. */
const lowerMaxAttendees = (id: number, max: number): Promise<unknown> =>
  getDb().execute({
    args: [max, id],
    sql: "UPDATE listings SET max_attendees = ? WHERE id = ?",
  });

describeWithEnv(
  "db > attendees > getListingRemainingForRange",
  { db: true, triggers: true },
  () => {
    test("empty list yields an empty map", async () => {
      const map = await getListingRemainingForRange([], null);
      expect(map.size).toBe(0);
    });

    test("standard listing: remaining is cap minus booked", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      await createTestAttendee(listing.id, listing.slug, "A", "a@example.com");
      expect(await remaining(listing.id, null)).toBe(4);
    });

    test("standard listing: remaining uses editable booked quantity", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 4,
        tickets_count: 0,
      });
      expect(await remaining(listing.id, null)).toBe(1);
    });

    test("standard listing: overbooked remaining clamps to zero", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      await createTestAttendee(listing.id, listing.slug, "A", "a@example.com");
      await createTestAttendee(listing.id, listing.slug, "B", "b@example.com");
      await createTestAttendee(listing.id, listing.slug, "C", "c@example.com");
      await lowerMaxAttendees(listing.id, 2);
      expect(await remaining(listing.id, null)).toBe(0);
    });

    test("standard listing: a capped group can shrink remaining", async () => {
      const group = await createTestGroup({ maxAttendees: 2 });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      const sibling = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      await createTestAttendee(sibling.id, sibling.slug, "A", "a@example.com");
      // Listing cap leaves 100, but the group only has 2 - 1 = 1 left.
      expect(await remaining(listing.id, null)).toBe(1);
    });

    test("standard listing: an uncapped group never limits remaining", async () => {
      const group = await createTestGroup({ maxAttendees: 0 });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 3,
      });
      expect(await remaining(listing.id, null)).toBe(3);
    });

    test("daily listing with no date uses the cumulative total", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 5 });
      await bookAttendee(listing, { date: "2026-02-10", quantity: 2 });
      // With no anchor date a daily listing falls back to its overall total,
      // the same path the calendar uses before a date is picked.
      expect(await remaining(listing.id, null)).toBe(3);
    });

    test("daily listing: remaining is per-date", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 3 });
      await bookAttendee(listing, { date: "2026-02-10", quantity: 2 });
      expect(await remaining(listing.id, "2026-02-10")).toBe(1);
      expect(await remaining(listing.id, "2026-02-11")).toBe(3);
    });

    test("daily listing: a multi-day range reports the tightest day", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 3 });
      await bookAttendee(listing, { date: "2026-05-02", quantity: 2 });
      // Range 05-01..05-03: only 05-02 is loaded, so 3 - 2 = 1 spot.
      expect(await remaining(listing.id, "2026-05-01", 3)).toBe(1);
    });

    test("daily listing: overbooked day clamps to zero", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 3 });
      await bookAttendee(listing, { date: "2026-02-10", quantity: 2 });
      await lowerMaxAttendees(listing.id, 1);
      expect(await remaining(listing.id, "2026-02-10")).toBe(0);
    });

    test("daily listing: a capped group shrinks the day it is full", async () => {
      const group = await createTestGroup({ maxAttendees: 2 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      const sibling = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 100,
      });
      await bookAttendee(sibling, { date: "2026-05-02", quantity: 2 });
      expect(await remaining(listing.id, "2026-05-02")).toBe(0);
      expect(await remaining(listing.id, "2026-05-03")).toBe(2);
    });

    test("daily listing: an uncapped group falls back to the listing cap", async () => {
      const group = await createTestGroup({ maxAttendees: 0 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 5,
      });
      await bookAttendee(listing, { date: "2026-05-02", quantity: 1 });
      expect(await remaining(listing.id, "2026-05-02")).toBe(4);
    });

    test("aggregates multiple bookings on the same listing and group", async () => {
      const group = await createTestGroup({ maxAttendees: 10 });
      const listing = await createDailyTestListing({
        groupId: group.id,
        maxAttendees: 5,
      });
      // Two separate attendees book the same listing + day → two interval rows.
      await bookAttendee(listing, { date: "2026-05-02", quantity: 1 });
      await bookAttendee(listing, { date: "2026-05-02", quantity: 2 });
      // Listing load 3 → 5 - 3 = 2; group load 3 → 10 - 3 = 7; the tighter wins.
      expect(await remaining(listing.id, "2026-05-02")).toBe(2);
    });

    test("resolves several listings in one call", async () => {
      const standard = await createTestListing({ maxAttendees: 5 });
      const daily = await createDailyTestListing({ maxAttendees: 3 });
      await bookAttendee(daily, { date: "2026-02-10", quantity: 1 });
      const map = await getListingRemainingForRange(
        [await row(standard.id), await row(daily.id)],
        "2026-02-10",
      );
      expect(map.get(standard.id)).toBe(5);
      expect(map.get(daily.id)).toBe(2);
    });

    test("stays within a constant query budget for a large catalogue", async () => {
      // More daily listings than the N+1 read guard threshold (25): a per-listing
      // fan-out would run the same overlap read once each and trip the guard.
      const listings: ListingWithCount[] = [];
      for (let i = 0; i < 28; i++) {
        const listing = await createDailyTestListing({ maxAttendees: 5 });
        listings.push(await row(listing.id));
      }
      await runWithQueryLogContext(async () => {
        enableQueryLog();
        const map = await getListingRemainingForRange(listings, "2026-05-01");
        expect(map.size).toBe(28);
        // Batched: a small constant number of round trips, not one per listing.
        expect(getQueryLog().length).toBeLessThanOrEqual(4);
      });
    });
  },
);
