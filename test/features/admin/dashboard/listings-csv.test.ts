import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createGroupWithListings,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";

const DAILY = {
  bookableDays: ["Monday"],
  listingType: "daily" as const,
  maximumDaysAfter: 14,
  minimumDaysBefore: 0,
};

describeWithEnv("server (admin listings CSV)", { db: true }, () => {
  describe("GET /admin/listings/csv", () => {
    testRequiresAuth("/admin/listings/csv");

    test("exports every listing as a CSV download", async () => {
      await createTestListing({ name: "Gala Night" });
      const response = await adminGet("/admin/listings/csv");
      says(response.headers.get("content-type"), "text/csv");
      says(
        response.headers.get("content-disposition"),
        'filename="listings.csv"',
      );
      const csv = await response.text();
      says(csv.split("\n")[0], "Name,Status,Type");
      says(csv, "Gala Night");
      expect(await wasActivityLogged("Listings CSV exported")).toBe(true);
    });

    test("filters the export to one type and names the file by type", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin/listings/csv?type=daily");
      says(
        response.headers.get("content-disposition"),
        'filename="listings_daily.csv"',
      );
      const csv = await response.text();
      says(csv, "Daily One");
      assert(!csv.includes("Standard One"));
      expect(
        await wasActivityLogged("Listings CSV exported (type: daily)"),
      ).toBe(true);
    });

    test("filters the export to one group's listings", async () => {
      const { group } = await createGroupWithListings("Autumn fair", [
        "Fair Listing",
      ]);
      await createTestListing({ name: "Outside Listing" });
      const response = await adminGet(`/admin/listings/csv?group=${group.id}`);
      const csv = await response.text();
      says(csv, "Fair Listing");
      assert(!csv.includes("Outside Listing"));
      expect(
        await wasActivityLogged("Listings CSV exported (group: Autumn fair)"),
      ).toBe(true);
    });

    test("an unknown group exports every listing", async () => {
      await createTestListing({ name: "Standard One" });
      const csv = await (
        await adminGet("/admin/listings/csv?group=999999")
      ).text();
      says(csv, "Standard One");
      expect(await wasActivityLogged("Listings CSV exported")).toBe(true);
    });

    test("an empty group exports just the header", async () => {
      const group = await createTestGroup({ name: "Empty group" });
      await createTestListing({ name: "Outside Listing" });
      const csv = await (
        await adminGet(`/admin/listings/csv?group=${group.id}`)
      ).text();
      // Only the header line: the group exists but holds no listings.
      says(csv, "Name,Status,Type");
      assert(!csv.includes("Outside Listing"));
      expect(
        await wasActivityLogged("Listings CSV exported (group: Empty group)"),
      ).toBe(true);
    });
  });
});
