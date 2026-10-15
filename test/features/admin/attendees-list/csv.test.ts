/**
 * The attendees CSV export: who may download it, which bookings it includes,
 * and the record it leaves behind.
 */

import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
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
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet, withTestSession } from "#test-utils/session.ts";
import {
  makeListing,
  seedGroupRoster,
  seedListingFilterPair,
} from "./helpers.ts";

const csvBody = async (query = ""): Promise<string> =>
  await (await adminGet(`/admin/attendees/csv${query}`)).text();

describeWithEnv("the attendees CSV export", { db: true }, () => {
  describe("GET /admin/attendees/csv", () => {
    testRequiresAuth("/admin/attendees/csv");

    test("exports matching attendees with their listing as CSV", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      const response = await adminGet("/admin/attendees/csv");
      assertStringIncludes(
        response.headers.get("content-type") ?? "",
        "text/csv",
      );
      assertStringIncludes(
        response.headers.get("content-disposition") ?? "",
        'filename="attendees.csv"',
      );
      const csv = await response.text();
      assertStringIncludes(csv, "Alice");
      assertStringIncludes(csv, "alice@example.com");
      assertStringIncludes(csv, "Gala Night");
    });

    test("includes every attendee when no listing is chosen", async () => {
      await seedListingFilterPair();
      const csv = await csvBody();
      assertStringIncludes(csv, "AliceOne");
      assertStringIncludes(csv, "BobTwo");
    });

    test("filters the export to a single listing", async () => {
      const { first } = await seedListingFilterPair();
      const csv = await csvBody(`?listing=${first.id}`);
      assertStringIncludes(csv, "AliceOne");
      assert(
        !csv.includes("BobTwo"),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(csv, "DoubleBooker");
      assertStringIncludes(csv, "Wanted Show");
      assert(
        !csv.includes("Other Show"),
        "the value should not contain the searched item",
      );
      expect(csv.split("\n")).toHaveLength(2);
    });

    test("returns just the header when the type filter matches no listings", async () => {
      const listing = await makeListing("Only Standard");
      await createTestAttendeeDirect(listing.id, "Lonely", "l@example.com");
      const csv = await csvBody("?type=daily");
      assert(
        !csv.includes("Lonely"),
        "the value should not contain the searched item",
      );
      // No matching listings → no rows, so only the header line is emitted.
      expect(csv.split("\n")).toHaveLength(1);
      assertStringIncludes(csv, "Listing");
    });

    test("exports only the chosen group's member listings", async () => {
      const { group } = await seedGroupRoster();

      const csv = await csvBody(`?group=${group.id}`);
      assertStringIncludes(csv, "FairOne");
      assertStringIncludes(csv, "FairTwo");
      assert(
        !csv.includes("OutsidePerson"),
        "the value should not contain the searched item",
      );
    });

    test("a group export omits a matched attendee's non-member bookings", async () => {
      const { group, listings } = await seedGroupRoster();
      const door = listings[0]!;
      const other = await makeListing("Other Show");
      await createMultiBookingAttendee("DoubleBooker", "db@example.com", [
        { listingId: door.id },
        { listingId: other.id },
      ]);

      const csv = await csvBody(`?group=${group.id}`);
      // Every member booking exports; the DoubleBooker's row is their booking
      // inside the group only — the export keeps every row within the
      // selected scope.
      assertStringIncludes(csv, "DoubleBooker");
      assertStringIncludes(csv, "Fair Door");
      assert(
        !csv.includes("Other Show"),
        "the value should not contain the searched item",
      );
      assert(
        !csv.includes("OutsidePerson"),
        "the value should not contain the searched item",
      );
      expect(csv.split("\n")).toHaveLength(4);
    });

    test("a group export for an empty group returns just the header", async () => {
      await seedListingFilterPair();
      const group = await createTestGroup({ name: "Empty group" });
      const csv = await csvBody(`?group=${group.id}`);
      expect(csv.split("\n")).toHaveLength(1);
      assertStringIncludes(csv, "Listing");
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
      assertArrayIncludes(
        entries.map((entry) => entry.message),
        ["Attendees CSV exported"],
      );
    });
  });
});
