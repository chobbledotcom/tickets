/**
 * Which listing a refused creation names. A capacity failure carries the ids
 * of the lines that did not fit, read back after the refused write, so a
 * caller can name the true culprit instead of the order's first listing.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { ListingBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getDb } from "#db/client.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTwoListingsSharingOnePlace } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const FULL_DAY = "2026-10-01";

/** A late customer's order is refused, naming exactly these listings. */
const expectLateOrderRefusedNaming = async (
  bookings: ListingBooking[],
  named: number[],
): Promise<void> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings,
    email: "late@example.com",
    name: "Late",
  });
  expect(result).toEqual({
    listingIds: named,
    reason: "capacity_exceeded",
    success: false,
  });
};

describeWithEnv(
  "db > a refused creation names the listing out of room",
  { db: true },
  () => {
    /** A roomy standard listing beside a daily one whose single place on
     * FULL_DAY is already taken. */
    const roomyAndFullDaily = async () => {
      const roomy = await createTestListing({ maxAttendees: 10 });
      const daily = await createDailyTestListing({
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });
      const taken = await attendeesApi.createAttendeeAtomic({
        bookings: [{ date: FULL_DAY, listingId: daily.id, quantity: 1 }],
        email: "first@example.com",
        name: "First",
      });
      if (!taken.success) throw new Error("Setup: the day did not book");
      return { daily, roomy };
    };

    test("a failed later line is the one named, not the first line", async () => {
      const { daily, roomy } = await roomyAndFullDaily();

      await expectLateOrderRefusedNaming(
        [
          { listingId: roomy.id, quantity: 1 },
          { date: FULL_DAY, listingId: daily.id, quantity: 1 },
        ],
        [daily.id],
      );
      // The refusal left nothing behind on the line that would have fit.
      expect((await getAttendeesRaw(roomy.id)).length).toBe(0);
    });

    test("a line that tips a shared group limit is the one named", async () => {
      // Each line fits ALONE, so only a check that counts the order's own
      // lines together can name the second one — the line the write batch
      // really aborted on.
      const { first, second } = await createTwoListingsSharingOnePlace();

      await expectLateOrderRefusedNaming(
        [
          { listingId: first.id, quantity: 1 },
          { listingId: second.id, quantity: 1 },
        ],
        [second.id],
      );
      expect((await getAttendeesRaw(first.id)).length).toBe(0);
    });

    test("lines on different days still name the full day's listing", async () => {
      // An operator can build one creation with lines on different days — a
      // dateless one included; the one-day cumulative check does not apply,
      // so each line is checked alone and the full day's listing is still
      // the one named.
      const { daily, roomy } = await roomyAndFullDaily();
      const roomyDaily = await createDailyTestListing({
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });

      await expectLateOrderRefusedNaming(
        [
          { listingId: roomy.id, quantity: 1 },
          { date: "2026-10-02", listingId: roomyDaily.id, quantity: 1 },
          { date: FULL_DAY, listingId: daily.id, quantity: 1 },
        ],
        [daily.id],
      );
    });

    test("a zero-quantity line does not draw the blame onto its listing", async () => {
      // The zero line passes the write guard even on a full listing, so the
      // refusal must name the real line's listing, not the zero line's.
      const { daily } = await roomyAndFullDaily();
      const other = await createDailyTestListing({
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });
      const taken = await attendeesApi.createAttendeeAtomic({
        bookings: [{ date: FULL_DAY, listingId: other.id, quantity: 1 }],
        email: "second@example.com",
        name: "Second",
      });
      if (!taken.success) throw new Error("Setup: the day did not book");

      await expectLateOrderRefusedNaming(
        [
          { date: FULL_DAY, listingId: daily.id, quantity: 0 },
          { date: FULL_DAY, listingId: other.id, quantity: 1 },
        ],
        [other.id],
      );
    });

    test("a line without a quantity is counted as one place", async () => {
      const { daily, roomy } = await roomyAndFullDaily();

      await expectLateOrderRefusedNaming(
        [
          { listingId: roomy.id, quantity: 1 },
          { date: FULL_DAY, listingId: daily.id },
        ],
        [daily.id],
      );
    });

    test("a line whose listing does not exist keeps the refusal", async () => {
      // The naming read cannot answer for a listing that is not there. The
      // refusal must still come back — with no listing named — rather than
      // being replaced by the diagnosis's own failure.
      await expectLateOrderRefusedNaming(
        [{ listingId: 999_999, quantity: 1 }],
        [],
      );
    });

    test("a listing another isolate deleted keeps the refusal too", async () => {
      // The isolate's listings cache still holds the listing, so the missing
      // check must read the database directly. The raw delete stands in for
      // another isolate: it bypasses the write sniffing that would clear this
      // isolate's cache.
      const listing = await createTestListing({ maxAttendees: 10 });
      const [cached] = await getListingsWithCountsByIds([listing.id]);
      expect(cached?.id).toBe(listing.id);
      await getDb().execute({
        args: [listing.id],
        sql: "DELETE FROM listings WHERE id = ?",
      });

      await expectLateOrderRefusedNaming(
        [{ listingId: listing.id, quantity: 1 }],
        [],
      );
    });
  },
);
