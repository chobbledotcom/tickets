/**
 * Tests for the batched listing+attendee reads
 * (`src/shared/db/listings/attendees.ts`), which pair one listing statement
 * with one attendee statement in a single round-trip.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import {
  getAttendeesByListingIds,
  getDailyListingAttendeeDates,
  getDailyListingAttendeesByDate,
  getListingWithAttendeeRaw,
  getListingWithAttendeesRaw,
} from "#db/listings/attendees.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { createServicingEvent } from "#test-utils/servicing.ts";

/** Book one attendee on 4 July and hand back the created row. */
const bookedAttendee = async (
  listing: { id: number },
  name: string,
): Promise<{ id: number }> => {
  const result = await bookAttendee(listing, { date: "2026-07-04", name });
  if (!result.success) throw new Error(`booking ${name} failed`);
  return result.attendees[0]!;
};

describeWithEnv(
  "db > listings > batched listing and attendee reads",
  { db: true, triggers: true },
  () => {
    test("getListingWithAttendeesRaw returns listing with attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@example.com",
      );

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.listing.attendee_count).toBe(1);
      expect(result?.attendeesRaw.length).toBe(1);
      // The attendee half really is the booking, not the listing row that
      // shares the same batch.
      expect(result?.attendeesRaw[0]?.listing_id).toBe(listing.id);
      expect(result?.attendeesRaw[0]?.quantity).toBe(1);
    });

    test("occupied dates cover every day a booking spans, once each", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 100,
        maximumDaysAfter: 60,
        thankYouUrl: "",
      });
      // A three-day stay and a one-day stay that starts on its last day, so
      // the overlap proves the days are deduplicated as well as expanded.
      await bookAttendee(listing, { date: "2026-06-15", durationDays: 3 });
      await bookAttendee(listing, { date: "2026-06-17", quantity: 1 });

      expect(await getDailyListingAttendeeDates()).toEqual([
        "2026-06-15",
        "2026-06-16",
        "2026-06-17",
      ]);
    });

    test("occupied dates ignore a listing that is not booked daily", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await createTestAttendee(listing.id, listing.slug, "Ann", "a@test.com");
      expect(await getDailyListingAttendeeDates()).toEqual([]);
    });

    test("reads the attendees of every listing asked for, and none when asked for none", async () => {
      const first = await createTestListing({ maxAttendees: 10 });
      const second = await createTestListing({ maxAttendees: 10 });
      await createTestAttendee(first.id, first.slug, "Ann", "ann@test.com");
      await createTestAttendee(second.id, second.slug, "Bo", "bo@test.com");

      const both = await getAttendeesByListingIds([first.id, second.id]);
      expect(both.length).toBe(2);
      const one = await getAttendeesByListingIds([first.id]);
      expect(one.map((a) => a.listing_id)).toEqual([first.id]);
      expect(await getAttendeesByListingIds([])).toEqual([]);
    });

    test("asking for active lines only drops the emptied ones", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const kept = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ann",
        "ann@test.com",
      );
      const emptied = await createTestAttendee(
        listing.id,
        listing.slug,
        "Bo",
        "bo@test.com",
      );
      await execute(
        "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
        [emptied.id],
      );

      // The default keeps every line, emptied ones included.
      expect((await getAttendeesByListingIds([listing.id])).length).toBe(2);
      // Both ways of asking for active lines only mean the same thing.
      for (const filter of [true, { activeOnly: true }] as const) {
        const active = await getAttendeesByListingIds([listing.id], filter);
        expect(active.map((a) => a.id)).toEqual([kept.id]);
      }
      // A filter object that says nothing about active lines keeps them all.
      expect(
        (
          await getAttendeesByListingIds([listing.id], {
            kindScope: "attendees",
          })
        ).length,
      ).toBe(2);
    });

    test("a servicing hold is read only when the wider scope asks for it", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await createServicingEvent({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        name: "Deep clean",
      });

      // The default scope is bookings made by people.
      expect(await getAttendeesByListingIds([listing.id])).toEqual([]);
      const wider = await getAttendeesByListingIds([listing.id], {
        kindScope: "attendees-and-servicing",
      });
      expect(wider.length).toBe(1);
      expect(wider[0]?.listing_id).toBe(listing.id);
    });

    test("the day view skips a hold that was emptied", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 100,
        maximumDaysAfter: 60,
        thankYouUrl: "",
      });
      const booked = await bookedAttendee(listing, "Kept");
      const emptied = await bookedAttendee(listing, "Emptied");
      await execute(
        "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
        [emptied.id],
      );

      const onTheDay = await getDailyListingAttendeesByDate("2026-07-04");
      expect(onTheDay.map((a) => a.id)).toEqual([booked.id]);
    });

    test("getListingWithAttendeesRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeesRaw(999);
      expect(result).toBeNull();
    });

    test("getListingWithAttendeeRaw returns listing with count fallback", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "bob@example.com",
      );

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.attendeeRaw?.id).toBe(attendee.id);
      expect(result?.attendeeRaw?.listing_id).toBe(listing.id);
      expect(result?.listing.attendee_count).toBe(1);
    });

    test("getListingWithAttendeeRaw has no attendee half when the id is unknown", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await getListingWithAttendeeRaw(listing.id, 999_999);
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.attendeeRaw).toBeNull();
    });

    test("getListingWithAttendeeRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeeRaw(999, 1);
      expect(result).toBeNull();
    });

    // Income is projected from the ledger, not stored, so a loader that skips
    // the projection reports NaN rather than a number.
    test("getListingWithAttendeesRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 2500,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(2500);
    });

    test("getListingWithAttendeeRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace",
        "grace@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 1800,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(1800);
    });
  },
);
