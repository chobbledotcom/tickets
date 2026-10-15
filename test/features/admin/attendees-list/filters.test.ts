/**
 * The attendees browser filters: narrowing the table to one listing, to a
 * listing type, and to one group's member listings.
 */

import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { setListingGroups } from "#db/groups.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  makeListing,
  seedListingFilterPair,
  seedGroupRoster as sharedSeedGroupRoster,
} from "./helpers.ts";

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
      says(html, "DoubleBooker");
      // The matched attendee's full listing list renders, filter or not.
      says(html, 'title="Also Booked, Booked Show"');
      assert(!html.includes("OtherPerson"));
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
      says(html, "StdGoer");
      assert(!html.includes("DailyGoer"));
      assert(!html.includes("MerchBuyer"));
      says(html, "Showing 1 attendee for");
      says(html, "<strong>Standard</strong>");
    });

    test("filters to daily listings (plural heading)", async () => {
      const { daily } = await seedTypes();
      await createTestAttendeeDirect(daily.id, "DailyTwo", "d2@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      says(html, "DailyGoer");
      says(html, "DailyTwo");
      assert(!html.includes("StdGoer"));
      says(html, "Showing 2 attendees for");
      says(html, "<strong>Daily</strong>");
    });

    test("filters to purchase-only listings", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=purchase-only");
      const html = await response.text();
      says(html, "MerchBuyer");
      assert(!html.includes("StdGoer"));
      says(html, "<strong>No check-in</strong>");
    });

    test("shows the type filter bar when several types exist", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      says(html, "Showing:");
      says(html, 'href="/admin/attendees?type=daily"');
      says(html, 'href="/admin/attendees?type=purchase-only"');
    });

    test("hides the type filter bar when only one type exists", async () => {
      const listing = await makeListing("Solo");
      await createTestAttendeeDirect(listing.id, "Solo", "solo@example.com");
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      assert(!html.includes("Showing:"));
    });

    test("treats an unknown type as 'all'", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=bogus");
      const html = await response.text();
      says(html, "StdGoer");
      says(html, "DailyGoer");
      says(html, "MerchBuyer");
    });

    test("a specific listing filter overrides the type filter", async () => {
      const { standard } = await seedTypes();
      const response = await adminGet(
        `/admin/attendees?type=daily&listing=${standard.id}`,
      );
      const html = await response.text();
      says(html, "StdGoer"); // the listing wins over the type
      assert(!html.includes("DailyGoer"));
    });

    test("shows nothing for a type with no listings", async () => {
      const listing = await makeListing("Only Standard");
      await createTestAttendeeDirect(listing.id, "Lonely", "l@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      says(html, "No attendees yet");
      assert(!html.includes("Lonely"));
    });
  });

  describe("the group filter", () => {
    const seedGroupRoster = sharedSeedGroupRoster;

    test("offers a group dropdown with every stored group", async () => {
      await seedGroupRoster();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      says(html, 'name="group"');
      says(html, "All groups");
      says(html, "Autumn fair");
    });

    test("hides the group dropdown when the site stores no groups", async () => {
      await seedListingFilterPair();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      assert(!html.includes('name="group"'));
    });

    test("narrows the table to the group's member listings", async () => {
      const { group } = await seedGroupRoster();
      await expectHtml(await adminGet(`/admin/attendees?group=${group.id}`), {
        contains: ["FairOne", "FairTwo"],
        notContains: ["OutsidePerson"],
      });
    });

    test("matches a listing that belongs to several groups", async () => {
      const { group, listings } = await seedGroupRoster();
      const shared = listings[0]!;
      const second = await createTestGroup({ name: "Spring fair" });
      await setListingGroups(shared.id, [group.id, second.id]);
      await expectHtml(await adminGet(`/admin/attendees?group=${second.id}`), {
        contains: ["FairOne"],
        notContains: ["FairTwo", "OutsidePerson"],
      });
    });

    test("keeps the group choice in the sort and CSV links", async () => {
      const { group } = await seedGroupRoster();
      const html = await (
        await adminGet(`/admin/attendees?group=${group.id}`)
      ).text();
      says(html, `group=${group.id}&sort=oldest`);
      says(html, `csv?group=${group.id}`);
    });

    test("falls back to all listings for an unknown group", async () => {
      const { group } = await seedGroupRoster();
      await expectHtml(await adminGet(`/admin/attendees?group=${group.id}9`), {
        contains: ["FairOne", "FairTwo", "OutsidePerson"],
      });
    });

    test("falls back to all listings for a malformed group", async () => {
      const { group } = await seedGroupRoster();
      await expectHtml(await adminGet(`/admin/attendees?group=${group.id}x`), {
        contains: ["FairOne", "FairTwo", "OutsidePerson"],
      });
    });

    test("an empty group shows the usual empty state", async () => {
      const group = await createTestGroup({ name: "Empty group" });
      await seedListingFilterPair();
      await expectHtml(await adminGet(`/admin/attendees?group=${group.id}`), {
        contains: ["No attendees yet"],
        notContains: ["AliceOne"],
      });
    });

    test("combines with the listing filter", async () => {
      const { group, listings, outside } = await seedGroupRoster();
      const workshop = listings[1]!;
      // A member listing: the group narrows nothing further.
      await expectHtml(
        await adminGet(
          `/admin/attendees?group=${group.id}&listing=${workshop.id}`,
        ),
        { contains: ["FairTwo"], notContains: ["FairOne", "OutsidePerson"] },
      );
      // A listing outside the group: both filters keep nothing.
      await expectHtml(
        await adminGet(
          `/admin/attendees?group=${group.id}&listing=${outside.id}`,
        ),
        { contains: ["No attendees yet"], notContains: ["OutsidePerson"] },
      );
    });

    test("combines with the type filter", async () => {
      const daily = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maxAttendees: 100,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name: "Fair Day Pass",
        thankYouUrl: "https://example.com",
      });
      const standard = await makeListing("Fair Stall");
      const group = await createTestGroup({ name: "Type fair" });
      await setListingGroups(daily.id, [group.id]);
      await setListingGroups(standard.id, [group.id]);
      await createTestAttendeeDirect(daily.id, "DailyGoer", "d@example.com");
      await createTestAttendeeDirect(standard.id, "StdGoer", "s@example.com");
      await expectHtml(
        await adminGet(`/admin/attendees?group=${group.id}&type=daily`),
        { contains: ["DailyGoer"], notContains: ["StdGoer"] },
      );
    });
  });
});
