/**
 * One capacity reading, many booking lengths: the snapshot must cost the same
 * whether one length or nine are asked about, and every length it works out
 * must match what reading that length on its own would say.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getListingRemainingForRange } from "#shared/db/attendees/capacity/remaining.ts";
import {
  groupRemainingFromSnapshot,
  loadCapacitySnapshot,
  remainingFromSnapshot,
} from "#shared/db/attendees/capacity/snapshot.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { requireValue } from "#shared/required-value.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** A start date comfortably inside every test listing's booking window. */
const startDate = (): string => addDays(todayInTz("UTC"), 2);

/** Enough for the snapshot's fixed reads, far below one read per length. */
const SNAPSHOT_CALL_LIMIT = 10;

/** The listing as stored now, with its booked total up to date. */
const reload = async (listingId: number): Promise<ListingWithCount> =>
  requireValue(
    await getListingWithCount(listingId),
    `Listing ${listingId} vanished`,
  );

/** Book units of a listing, on a day when one is given. */
const book = async (
  listingId: number,
  quantity: number,
  date?: string,
): Promise<void> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [{ ...(date ? { date } : {}), listingId, quantity }],
    email: "booker@example.com",
    name: "Booker",
  });
  if (!result.success) throw new Error(`Could not book: ${result.reason}`);
};

describeWithEnv(
  "db > attendees > capacity snapshot",
  { db: true, triggers: true },
  () => {
    /** One daily listing per booking length, each a different number of days. */
    const listingsOfLengths = async (
      label: string,
      lengths: number[],
    ): Promise<ListingWithCount[]> => {
      const listings: ListingWithCount[] = [];
      for (const days of lengths) {
        listings.push(
          await createDailyTestListing({
            durationDays: days,
            name: `${label} ${days}`,
          }),
        );
      }
      return listings;
    };

    /** Read every listing over its own length, from one snapshot. */
    const remainingPerOwnLength = async (
      listings: ListingWithCount[],
      date: string,
    ): Promise<Map<number, number>> => {
      const lengthOf = (listing: ListingWithCount): number =>
        listing.duration_days;
      const snapshot = await loadCapacitySnapshot(
        listings,
        date,
        Math.max(...listings.map(lengthOf)),
      );
      return remainingFromSnapshot(snapshot, listings, lengthOf);
    };

    test("reads nine booking lengths in the same calls as one", async () => {
      const date = startDate();
      const one = await listingsOfLengths("Single", [1]);
      const nine = await listingsOfLengths("Many", [1, 2, 3, 4, 5, 6, 7, 8, 9]);

      const calls = (listings: ListingWithCount[]): Promise<number> =>
        countDatabaseCalls(SNAPSHOT_CALL_LIMIT, () =>
          remainingPerOwnLength(listings, date),
        );

      expect(await calls(nine)).toBe(await calls(one));
    });

    test("says the same as reading each booking length on its own", async () => {
      const date = startDate();
      const listings = await listingsOfLengths("Agrees", [1, 2, 3]);
      // A booking on the third day is inside the 3-day stay and outside the
      // 1-day one, so the lengths must not all report the same figure.
      for (const listing of listings) {
        await book(listing.id, 4, addDays(date, 2));
      }

      const fromSnapshot = await remainingPerOwnLength(listings, date);

      for (const listing of listings) {
        const onItsOwn = await getListingRemainingForRange(
          [listing],
          date,
          listing.duration_days,
        );
        expect(fromSnapshot.get(listing.id)).toBe(onItsOwn.get(listing.id));
      }
      // The one-day stay misses the booking; the three-day stay meets it.
      expect(fromSnapshot.get(listings[0]!.id)).toBe(10);
      expect(fromSnapshot.get(listings[2]!.id)).toBe(6);
    });

    test("judges a group over the widest length any of its listings takes", async () => {
      const date = startDate();
      const group = await createTestGroup({ maxAttendees: 10, name: "Shared" });
      const short = await createDailyTestListing({
        durationDays: 1,
        groupId: group.id,
        name: "Short stay",
      });
      const long = await createDailyTestListing({
        durationDays: 3,
        groupId: group.id,
        name: "Long stay",
      });
      // Booked on the third day: only the three-day stay reaches it.
      await book(short.id, 4, addDays(date, 2));

      const snapshot = await loadCapacitySnapshot([short, long], date, 3);

      expect(
        groupRemainingFromSnapshot(snapshot, new Map([[group.id, 1]])).get(
          group.id,
        ),
      ).toBe(10);
      expect(
        groupRemainingFromSnapshot(snapshot, new Map([[group.id, 3]])).get(
          group.id,
        ),
      ).toBe(6);
    });

    test("reads a listing with no date by its running total", async () => {
      const listing = await createTestListing({
        maxAttendees: 8,
        name: "Dateless",
      });
      await book(listing.id, 3);
      const booked = await reload(listing.id);
      const reread = (await getListingRemainingForRange([booked], null)).get(
        listing.id,
      );

      const snapshot = await loadCapacitySnapshot([booked], null, 1);
      const remaining = remainingFromSnapshot(snapshot, [booked], () => 1);

      expect(remaining.get(listing.id)).toBe(5);
      expect(remaining.get(listing.id)).toBe(reread);
    });

    test("still reads a dateless listing by its total when a date is chosen", async () => {
      const date = startDate();
      const anyDay = await createTestListing({
        maxAttendees: 8,
        name: "Sold any day",
      });
      const [oneNight] = await listingsOfLengths("Alongside", [1]);
      // Booked with no date at all: only a running total can see it.
      await book(anyDay.id, 3);
      const listings = [await reload(anyDay.id), oneNight!];

      const snapshot = await loadCapacitySnapshot(listings, date, 1);
      const remaining = remainingFromSnapshot(snapshot, listings, () => 1);

      expect(remaining.get(anyDay.id)).toBe(5);
      expect(remaining.get(oneNight!.id)).toBe(10);
    });

    test("a group's limit lowers what its listing has left", async () => {
      const date = startDate();
      const group = await createTestGroup({ maxAttendees: 4, name: "Capped" });
      const listing = await createDailyTestListing({
        durationDays: 1,
        groupId: group.id,
        maxAttendees: 10,
        name: "Roomy but capped",
      });

      const snapshot = await loadCapacitySnapshot([listing], date, 1);

      // Its own 10 gives way to the group's 4, and the group reads the same.
      expect(
        remainingFromSnapshot(snapshot, [listing], () => 1).get(listing.id),
      ).toBe(4);
      expect(
        groupRemainingFromSnapshot(snapshot, new Map([[group.id, 1]])).get(
          group.id,
        ),
      ).toBe(4);
    });

    test("reads one day for a stay of no days at all", async () => {
      const date = startDate();
      const [listing] = await listingsOfLengths("Zero", [1]);
      await book(listing!.id, 4, date);

      const snapshot = await loadCapacitySnapshot([listing!], date, 0);
      const remaining = remainingFromSnapshot(snapshot, [listing!], () => 0);

      // Not Infinity: a span of no days would otherwise read as no limit.
      expect(remaining.get(listing!.id)).toBe(6);
    });

    test("skips the membership lookup when the caller already knows it", async () => {
      const date = startDate();
      const listings = await listingsOfLengths("Known", [2]);
      const membership = await listingGroups.getIdsByKeys(
        listings.map((listing) => listing.id),
      );

      const withLookup = await countDatabaseCalls(SNAPSHOT_CALL_LIMIT, () =>
        loadCapacitySnapshot(listings, date, 2),
      );
      const withKnown = await countDatabaseCalls(SNAPSHOT_CALL_LIMIT, () =>
        loadCapacitySnapshot(listings, date, 2, membership),
      );

      expect(withKnown).toBe(withLookup - 1);
    });
  },
);
