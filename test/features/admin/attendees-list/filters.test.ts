/**
 * The attendees browser filters: narrowing the table to one listing, and
 * narrowing it to a listing type.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import { makeListing, seedListingFilterPair } from "./helpers.ts";

const expectFallsBackToAllListings = async (
  listingParam: (firstId: number) => string,
): Promise<void> => {
  const { first } = await seedListingFilterPair();
  await expectHtml(
    await adminGet(`/admin/attendees?listing=${listingParam(first.id)}`),
    { contains: ["AliceOne", "BobTwo"] },
  );
};

describeWithEnv("the attendees browser filters", { db: true }, () => {
  describe("the listing filter", () => {
    test("shows attendees from every listing when nothing is chosen", async () => {
      await seedListingFilterPair();
      await expectHtml(await adminGet("/admin/attendees"), {
        contains: ["AliceOne", "BobTwo"],
      });
    });

    test("filters the table to a single listing", async () => {
      const { first } = await seedListingFilterPair();

      await expectHtml(await adminGet(`/admin/attendees?listing=${first.id}`), {
        contains: ["AliceOne", `selected value="${first.id}"`],
        notContains: ["BobTwo"],
      });
    });

    test("falls back to all listings for an unknown listing filter", async () => {
      await expectFallsBackToAllListings(() => "999999");
    });

    test("falls back to all listings for a malformed listing filter", async () => {
      await expectFallsBackToAllListings((id) => `${id}x`);
    });

    test("a listing filter matches attendees but still shows their other listings", async () => {
      const booked = await makeListing("Booked Show");
      const also = await makeListing("Also Booked");
      const unrelated = await makeListing("Unrelated Show");
      await createMultiBookingAttendee("DoubleBooker", "db@example.com", [
        { listingId: booked.id },
        { listingId: also.id },
      ]);
      await createTestAttendeeDirect(
        unrelated.id,
        "OtherPerson",
        "other@example.com",
      );

      const response = await adminGet(`/admin/attendees?listing=${booked.id}`);
      const html = await response.text();
      expect(html).toContain("DoubleBooker");
      // The matched attendee's full listing list renders, filter or not.
      expect(html).toContain('title="Also Booked, Booked Show"');
      expect(html).not.toContain("OtherPerson");
    });
  });

  describe("the type filter", () => {
    const makeDaily = (name: string) =>
      createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maxAttendees: 100,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name,
        thankYouUrl: "https://example.com",
      });

    /** One attendee on each of a standard, daily, and purchase-only listing. */
    const seedTypes = async () => {
      const standard = await makeListing("Std Show");
      const daily = await makeDaily("Day Pass");
      const merch = await createTestListing({
        maxAttendees: 100,
        name: "Tote Bag",
        purchaseOnly: true,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendeeDirect(standard.id, "StdGoer", "s@example.com");
      await createTestAttendeeDirect(daily.id, "DailyGoer", "d@example.com");
      await createTestAttendeeDirect(merch.id, "MerchBuyer", "m@example.com");
      return { daily, merch, standard };
    };

    test("filters to standard listings (singular heading)", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=standard");
      const html = await response.text();
      expect(html).toContain("StdGoer");
      expect(html).not.toContain("DailyGoer");
      expect(html).not.toContain("MerchBuyer");
      expect(html).toContain("Showing 1 attendee for");
      expect(html).toContain("<strong>Standard</strong>");
    });

    test("filters to daily listings (plural heading)", async () => {
      const { daily } = await seedTypes();
      await createTestAttendeeDirect(daily.id, "DailyTwo", "d2@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      expect(html).toContain("DailyGoer");
      expect(html).toContain("DailyTwo");
      expect(html).not.toContain("StdGoer");
      expect(html).toContain("Showing 2 attendees for");
      expect(html).toContain("<strong>Daily</strong>");
    });

    test("filters to purchase-only listings", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=purchase-only");
      const html = await response.text();
      expect(html).toContain("MerchBuyer");
      expect(html).not.toContain("StdGoer");
      expect(html).toContain("<strong>No check-in</strong>");
    });

    test("shows the type filter bar when several types exist", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      expect(html).toContain("Showing:");
      expect(html).toContain('href="/admin/attendees?type=daily"');
      expect(html).toContain('href="/admin/attendees?type=purchase-only"');
    });

    test("hides the type filter bar when only one type exists", async () => {
      const listing = await makeListing("Solo");
      await createTestAttendeeDirect(listing.id, "Solo", "solo@example.com");
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      expect(html).not.toContain("Showing:");
    });

    test("treats an unknown type as 'all'", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=bogus");
      const html = await response.text();
      expect(html).toContain("StdGoer");
      expect(html).toContain("DailyGoer");
      expect(html).toContain("MerchBuyer");
    });

    test("a specific listing filter overrides the type filter", async () => {
      const { standard } = await seedTypes();
      const response = await adminGet(
        `/admin/attendees?type=daily&listing=${standard.id}`,
      );
      const html = await response.text();
      expect(html).toContain("StdGoer"); // the listing wins over the type
      expect(html).not.toContain("DailyGoer");
    });

    test("shows nothing for a type with no listings", async () => {
      const listing = await makeListing("Only Standard");
      await createTestAttendeeDirect(listing.id, "Lonely", "l@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      expect(html).toContain("No attendees yet");
      expect(html).not.toContain("Lonely");
    });
  });
});
