import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

const makeListing = (name: string) =>
  createTestListing({
    maxAttendees: 100,
    name,
    thankYouUrl: "https://example.com",
  });

describeWithEnv("server (admin attendees CSV)", { db: true }, () => {
  describe("GET /admin/attendees/csv", () => {
    testRequiresAuth("/admin/attendees/csv");

    test("exports matching attendees with their listing as CSV", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      const response = await adminGet("/admin/attendees/csv");
      expect(response.headers.get("content-type")).toContain("text/csv");
      expect(response.headers.get("content-disposition")).toContain(
        'filename="attendees.csv"',
      );
      const csv = await response.text();
      expect(csv).toContain("Alice");
      expect(csv).toContain("alice@example.com");
      expect(csv).toContain("Gala Night");
    });

    test("filters the export to a single listing", async () => {
      const first = await makeListing("First");
      const second = await makeListing("Second");
      await createTestAttendeeDirect(first.id, "AliceOne", "a1@example.com");
      await createTestAttendeeDirect(second.id, "BobTwo", "b2@example.com");
      const response = await adminGet(
        `/admin/attendees/csv?listing=${first.id}`,
      );
      const csv = await response.text();
      expect(csv).toContain("AliceOne");
      expect(csv).not.toContain("BobTwo");
    });

    test("a filtered export omits a matched attendee's other-listing bookings", async () => {
      const wanted = await makeListing("Wanted Show");
      const other = await makeListing("Other Show");
      await createMultiBookingAttendee("DoubleBooker", "db@example.com", [
        { listingId: wanted.id },
        { listingId: other.id },
      ]);

      const response = await adminGet(
        `/admin/attendees/csv?listing=${wanted.id}`,
      );
      const csv = await response.text();
      // One row: the booking on the filtered listing only — the grouped
      // attendees PAGE shows their other listings, but the export must not.
      expect(csv).toContain("DoubleBooker");
      expect(csv).toContain("Wanted Show");
      expect(csv).not.toContain("Other Show");
      expect(csv.split("\n")).toHaveLength(2);
    });

    test("returns just the header when the type filter matches no listings", async () => {
      const listing = await makeListing("Only Standard");
      await createTestAttendeeDirect(listing.id, "Lonely", "l@example.com");
      const response = await adminGet("/admin/attendees/csv?type=daily");
      const csv = await response.text();
      expect(csv).not.toContain("Lonely");
      // No matching listings → no rows, so only the header line is emitted.
      expect(csv.split("\n")).toHaveLength(1);
      expect(csv).toContain("Listing");
    });
  });
});
