/**
 * The attendees CSV export: who may download it, which bookings it includes,
 * and the record it leaves behind.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { ATTENDEES_PAGE_SIZE } from "#db/attendees/queries.ts";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet, withTestSession } from "#test-utils/session.ts";
import { makeListing, seedListingFilterPair } from "./helpers.ts";

const csvBody = async (query = ""): Promise<string> =>
  await (await adminGet(`/admin/attendees/csv${query}`)).text();

describeWithEnv("the attendees CSV export", { db: true }, () => {
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

    test("includes every attendee when no listing is chosen", async () => {
      await seedListingFilterPair();
      const csv = await csvBody();
      expect(csv).toContain("AliceOne");
      expect(csv).toContain("BobTwo");
    });

    test("filters the export to a single listing", async () => {
      const { first } = await seedListingFilterPair();
      const csv = await csvBody(`?listing=${first.id}`);
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

      const csv = await csvBody(`?listing=${wanted.id}`);
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
      const csv = await csvBody("?type=daily");
      expect(csv).not.toContain("Lonely");
      // No matching listings → no rows, so only the header line is emitted.
      expect(csv.split("\n")).toHaveLength(1);
      expect(csv).toContain("Listing");
    });

    test("keeps reading pages until it has every booking", async () => {
      const listing = await createTestListing({
        maxAttendees: ATTENDEES_PAGE_SIZE * 3,
      });
      // One page's worth plus a few, so an export that stopped after the
      // first page — or walked backwards — would come back short.
      const total = ATTENDEES_PAGE_SIZE + 5;
      await seedFillerAttendees(listing.id, total);

      const csv = await csvBody();
      const rows = csv.trim().split("\n").length - 1;
      expect(rows).toBe(total);
    });

    test("notes that the attendee list was exported", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await csvBody();
      const entries = await withTestSession(() => getAllActivityLog(20));
      expect(entries.map((entry) => entry.message)).toContain(
        "Attendees CSV exported",
      );
    });
  });
});
