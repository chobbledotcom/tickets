/**
 * Tests for the batched listing+attendee reads
 * (`src/shared/db/listings/attendees.ts`), which pair one listing statement
 * with one attendee statement in a single round-trip.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getListingWithAttendeeRaw,
  getListingWithAttendeesRaw,
} from "#db/listings/attendees.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

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
      expect(result?.attendeeRaw).not.toBeNull();
      expect(result?.listing.attendee_count).toBe(1);
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
