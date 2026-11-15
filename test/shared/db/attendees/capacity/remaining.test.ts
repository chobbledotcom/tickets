import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getListingRemainingForRange } from "#db/attendees/capacity/remaining.ts";
import { getDb } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createListings,
  dailyListingBooked,
  dailyMemberOfGroup,
  groupWithMembers,
  setStoredBookedQuantity,
} from "#test-utils/db-helpers/capacity-fixtures.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { ListingWithCount } from "#types";

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
  getDb().execute(
    sql`UPDATE listings SET max_attendees = ${max} WHERE id = ${id}`,
  );

describeWithEnv(
  "db > attendees > getListingRemainingForRange",
  { db: true, triggers: true },
  () => {
    test("empty list yields an empty map", async () => {
      const map = await getListingRemainingForRange([], null);
      expect(map.size).toBe(0);
    });

    /** A standard listing's booked places, and the remaining units the query
     * reports: rows it counts, a stored total it trusts, or a cap below what
     * was sold. */
    const standardCases: {
      booked: number[];
      cap: number;
      left: number;
      loweredCap?: number;
      name: string;
      stored?: number;
    }[] = [
      {
        booked: [1],
        cap: 5,
        left: 4,
        name: "standard listing: remaining is cap minus booked",
      },
      {
        booked: [],
        cap: 5,
        left: 1,
        name: "standard listing: remaining uses editable booked quantity",
        stored: 4,
      },
      {
        booked: [1, 1, 1],
        cap: 5,
        left: -1,
        loweredCap: 2,
        name: "standard listing: overbooked remaining exposes the negative overage",
      },
    ];
    for (const {
      booked,
      cap,
      left,
      loweredCap,
      name,
      stored,
    } of standardCases) {
      test(name, async () => {
        const listing = await createTestListing({ maxAttendees: cap });
        for (const quantity of booked) {
          await bookAttendee(listing, { quantity });
        }
        if (stored !== undefined) {
          await setStoredBookedQuantity(listing.id, stored);
        }
        if (loweredCap !== undefined) {
          await lowerMaxAttendees(listing.id, loweredCap);
        }
        expect(await remaining(listing.id, null)).toBe(left);
      });
    }

    test("standard listing: a capped group can shrink remaining", async () => {
      const { members } = await groupWithMembers({ cap: 2, count: 2 });
      const [listing, sibling] = members;
      await bookAttendee(sibling!, { quantity: 1 });
      // Listing cap leaves 100, but the group only has 2 - 1 = 1 left.
      expect(await remaining(listing!.id, null)).toBe(1);
    });

    test("standard listing: an uncapped group never limits remaining", async () => {
      const { members } = await groupWithMembers({
        cap: 0,
        count: 1,
        maxAttendees: 3,
      });
      expect(await remaining(members[0]!.id, null)).toBe(3);
    });

    /** One daily listing with one booking, and the remaining units each query
     * reports for it. */
    for (const { booked, day, cap, name, queries } of [
      {
        booked: 2,
        cap: 5,
        day: "2026-02-10",
        name: "daily listing with no date uses the cumulative total",
        // With no anchor date a daily listing falls back to its overall total,
        // the same path the calendar uses before a date is picked.
        queries: [{ date: null, left: 3 }],
      },
      {
        booked: 2,
        cap: 3,
        day: "2026-02-10",
        name: "daily listing: remaining is per-date",
        queries: [
          { date: "2026-02-10", left: 1 },
          { date: "2026-02-11", left: 3 },
        ],
      },
      {
        booked: 2,
        cap: 3,
        day: "2026-05-02",
        name: "daily listing: a multi-day range reports the tightest day",
        // Range 05-01..05-03: only 05-02 is loaded, so 3 - 2 = 1 spot.
        queries: [{ date: "2026-05-01", durationDays: 3, left: 1 }],
      },
    ]) {
      test(name, async () => {
        const listing = await dailyListingBooked({
          booked: [{ day, quantity: booked }],
          maxAttendees: cap,
        });
        for (const { date, durationDays, left } of queries) {
          expect(await remaining(listing.id, date, durationDays)).toBe(left);
        }
      });
    }

    test("daily listing: overbooked day exposes the negative overage", async () => {
      const listing = await dailyListingBooked({
        booked: [{ day: "2026-02-10", quantity: 2 }],
        maxAttendees: 3,
      });
      await lowerMaxAttendees(listing.id, 1);
      expect(await remaining(listing.id, "2026-02-10")).toBe(-1);
    });

    test("daily listing: a capped group shrinks the day it is full", async () => {
      const { members } = await groupWithMembers({
        cap: 2,
        count: 2,
        daily: true,
      });
      const [listing, sibling] = members;
      await bookAttendee(sibling!, { date: "2026-05-02", quantity: 2 });
      expect(await remaining(listing!.id, "2026-05-02")).toBe(0);
      expect(await remaining(listing!.id, "2026-05-03")).toBe(2);
    });

    /** One daily member of a group capped at `cap`, with `bookings` places
     * taken on 2026-05-02: the tighter of the group's day load and the
     * listing's own places answers. */
    const dailyMemberCases: {
      bookings: number[];
      cap: number;
      left: number;
      name: string;
    }[] = [
      {
        bookings: [1],
        cap: 0,
        // The group cap of 0 means no limit, so the listing's 5 places stand:
        // 5 - 1 = 4.
        left: 4,
        name: "daily listing: an uncapped group falls back to the listing cap",
      },
      {
        bookings: [1, 2],
        cap: 10,
        // Listing load 3 → 5 - 3 = 2; group load 3 → 10 - 3 = 7; the tighter
        // wins. Two separate attendees book the same listing + day, so the
        // listing holds two interval rows.
        left: 2,
        name: "aggregates multiple bookings on the same listing and group",
      },
    ];
    for (const { bookings, cap, left, name } of dailyMemberCases) {
      test(name, async () => {
        const listing = await dailyMemberOfGroup(cap, 5);
        for (const quantity of bookings) {
          await bookAttendee(listing, { date: "2026-05-02", quantity });
        }
        expect(await remaining(listing.id, "2026-05-02")).toBe(left);
      });
    }

    test("standard listings with a date skip daily-loop capacity rules", async () => {
      const listing = await createTestListing({ maxAttendees: 8 });
      expect(await remaining(listing.id, "2026-02-10")).toBe(8);
    });

    test("resolves several listings in one call", async () => {
      const standard = await createTestListing({ maxAttendees: 5 });
      const daily = await createDailyTestListing({ maxAttendees: 3 });
      await bookAttendee(daily, { date: "2026-02-10", quantity: 1 });
      const map = await getListingRemainingForRange(
        [await row(standard.id), await row(daily.id)],
        "2026-02-10",
      );
      expect([...map]).toEqual([
        [standard.id, 5],
        [daily.id, 2],
      ]);
    });

    test("stays within a constant query budget for a large catalogue", async () => {
      // More daily listings than the N+1 read guard threshold (25): a per-listing
      // fan-out would run the same overlap read once each and trip the guard.
      const listings = await createListings({
        count: 28,
        daily: true,
        maxAttendees: 5,
      });
      await withRequestContext(async () => {
        enableQueryLog();
        const map = await getListingRemainingForRange(listings, "2026-05-01");
        expect(map.size).toBe(28);
        // Batched: a small constant number of round trips, not one per listing.
        expect(getQueryLog().length).toBeLessThanOrEqual(4);
      });
    });
  },
);
