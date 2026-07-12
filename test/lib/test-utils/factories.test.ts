import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  createTestDbWithSetup,
  rawListingRange,
  resetDb,
} from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";

describe("test-utils — listing & attendee factories", () => {
  afterEach(() => {
    resetDb();
  });

  describe("bookTestAttendee", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("books one attendee onto every listing given", async () => {
      const a = await createTestListing({ maxAttendees: 10 });
      const b = await createTestListing({ maxAttendees: 10, name: "B" });
      const attendee = await bookTestAttendee([a.id, b.id], "Multi");
      expect(attendee.id).toBeGreaterThan(0);
    });

    test("rolls back the partial booking and fails loudly when a listing can't take it", async () => {
      const open = await createTestListing({ maxAttendees: 10 });
      const full = await createTestListing({ maxAttendees: 1, name: "Full" });
      await bookTestAttendee([full.id], "Filler"); // uses the only spot

      await expect(
        bookTestAttendee([open.id, full.id], "Partial"),
      ).rejects.toThrow("Failed to book test attendee onto all 2 listing(s)");

      // The booking that DID land on `open` is rolled back, so no stray
      // attendee is left occupying capacity or skewing later assertions.
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect((await getAttendeesRaw(open.id)).length).toBe(0);

      // Regression: the rollback must also reverse the contact-activity count
      // that the greedy create recorded — under the same source — or the
      // contact keeps a booking that no longer exists.
      const { getContactCountFields, hashEmail } = await import(
        "#shared/db/contact-preferences.ts"
      );
      const counts = await getContactCountFields(
        await hashEmail("partial@test.com"),
      );
      expect(counts.publicBookingCount).toBe(0);
    });
  });

  describe("createTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an listing with thankYouUrl override", async () => {
      const listing = await createTestListing({
        thankYouUrl: "https://custom.example.com/done",
      });
      expect(listing.thank_you_url).toBe("https://custom.example.com/done");
      expect(listing.slug).toBeTruthy();
    });

    test("creates an listing with default settings", async () => {
      const listing = await createTestListing();
      expect(listing.id).toBeGreaterThan(0);
      expect(listing.max_attendees).toBe(100);
      expect(listing.active).toBe(true);
    });

    test("creates an listing with maxPrice", async () => {
      const listing = await createTestListing({ maxPrice: 5000 });
      expect(listing.max_price).toBe(5000);
    });
  });

  describe("updateTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("updates listing fields via the REST API", async () => {
      const listing = await createTestListing();
      const updated = await updateTestListing(listing.id, {
        maxAttendees: 200,
        thankYouUrl: "https://thanks.example.com",
        unitPrice: 1500,
        webhookUrl: "https://hook.example.com",
      });
      expect(updated.max_attendees).toBe(200);
      expect(updated.unit_price).toBe(1500);
      expect(updated.webhook_url).toBe("https://hook.example.com");
      expect(updated.thank_you_url).toBe("https://thanks.example.com");
    });

    test("throws when listing does not exist", async () => {
      await expect(
        updateTestListing(99999, { maxAttendees: 50 }),
      ).rejects.toThrow("Listing not found: 99999");
    });

    test("preserves existing values when updates are partial", async () => {
      const listing = await createTestListing({
        thankYouUrl: "https://original.example.com",
      });
      const updated = await updateTestListing(listing.id, {
        maxAttendees: 50,
      });
      expect(updated.max_attendees).toBe(50);
      expect(updated.thank_you_url).toBe("https://original.example.com");
    });

    test("clears fields when set to zero/empty", async () => {
      const listing = await createTestListing({
        unitPrice: 1000,
        webhookUrl: "https://hook.example.com",
      });
      const updated = await updateTestListing(listing.id, {
        unitPrice: 0,
        webhookUrl: "",
      });
      expect(updated.unit_price).toBe(0);
      expect(updated.webhook_url).toBe("");
    });

    test("updates max_price when explicitly set", async () => {
      const listing = await createTestListing();
      const updated = await updateTestListing(listing.id, { maxPrice: 7500 });
      expect(updated.max_price).toBe(7500);
    });

    test("preserves existing max_price when not specified in update", async () => {
      const listing = await createTestListing({ maxPrice: 3000 });
      const updated = await updateTestListing(listing.id, { maxAttendees: 50 });
      expect(updated.max_price).toBe(3000);
    });
  });

  describe("deactivateTestListing", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("throws when listing does not exist", async () => {
      await expect(deactivateTestListing(99999)).rejects.toThrow(
        "Listing not found: 99999",
      );
    });

    test("deactivates an existing listing", async () => {
      const listing = await createTestListing();
      expect(listing.active).toBe(true);
      await deactivateTestListing(listing.id);
      const { getListingWithCount } = await import(
        "#shared/db/listings/records.ts"
      );
      const updated = await getListingWithCount(listing.id);
      expect(updated!.active).toBe(false);
    });
  });

  describe("createTestAttendee", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an attendee via the public ticket form", async () => {
      const listing = await createTestListing();
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Doe",
        "jane@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.listing_id).toBe(listing.id);
      expect(attendee.quantity).toBe(1);
    });

    test("creates an attendee with custom quantity", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob Smith",
        "bob@example.com",
        3,
      );
      expect(attendee.quantity).toBe(3);
    });
  });

  describe("createTestAttendeeDirect", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("creates an attendee directly and returns plaintext token", async () => {
      const { createTestAttendeeDirect } = await import(
        "#test-utils/db-helpers/attendees.ts"
      );
      const listing = await createTestListing();
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Test User",
        "test@example.com",
      );
      expect(attendee.id).toBeGreaterThan(0);
      expect(attendee.listing_id).toBe(listing.id);
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    test("throws error when capacity is exceeded", async () => {
      const { createTestAttendeeDirect } = await import(
        "#test-utils/db-helpers/attendees.ts"
      );
      const listing = await createTestListing({ maxAttendees: 1 });

      // Fill the listing
      await createTestAttendeeDirect(listing.id, "First", "first@example.com");

      // Second attendee should fail
      await expect(
        createTestAttendeeDirect(listing.id, "Second", "second@example.com"),
      ).rejects.toThrow("Failed to create attendee");
    });
  });

  describe("rawListingRange", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    test("returns start_at/end_at/quantity for the first booking", async () => {
      const { createDailyTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
      const { createAttendeeAtomic } = await import(
        "#shared/db/attendees/api.ts"
      );
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", listingId: listing.id, quantity: 3 }],
        email: "alice@test.com",
        name: "Alice",
      });
      if (!result.success) throw new Error("create failed");

      const range = await rawListingRange(listing.id);
      expect(range).not.toBeNull();
      expect(range!.start_at).toBe("2026-05-01T00:00:00Z");
      expect(range!.end_at).toBe("2026-05-02T00:00:00.000Z");
      expect(range!.quantity).toBe(3);
    });

    test("returns null when no bookings exist for the listing", async () => {
      const listing = await createTestListing();
      expect(await rawListingRange(listing.id)).toBeNull();
    });
  });
});
