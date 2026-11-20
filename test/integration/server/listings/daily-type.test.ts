import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  assertAdminHtml,
  expectHtmlResponse,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  submitListingCreate,
  submitListingEdit,
} from "#test-utils/listing-submits.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

describeWithEnv("server listings > daily listing type", { db: true }, () => {
  describe("daily listing type", () => {
    test("creates a daily listing with custom config", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday", "Wednesday", "Friday"],
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 2,
      });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.listingType).toBe("daily");
      expect(saved?.bookableDays).toEqual(["Monday", "Wednesday", "Friday"]);
      expect(saved?.minimumDaysBefore).toBe(2);
      expect(saved?.maximumDaysAfter).toBe(30);
    });

    test("creates standard listing with default daily config", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.listingType).toBe("standard");
      expect(saved?.bookableDays).toEqual([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
      expect(saved?.minimumDaysBefore).toBe(1);
      expect(saved?.maximumDaysAfter).toBe(90);
    });

    test("admin listing detail page shows Daily type for daily listings", async () => {
      const { listing } = await setupListingAndLogin({
        bookableDays: ["Monday", "Tuesday"],
        listingType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 3,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Type",
        "Daily",
        "Bookable Days",
        "Monday, Tuesday",
        "Booking Window",
        "3 to 60 days",
        "Capacity of",
        "applies per date",
      );
    });

    test("admin listing detail page shows Standard type without daily config", async () => {
      const { listing } = await setupListingAndLogin();

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Type",
        "Standard",
      );
      assert(!html.includes("Bookable Days"));
      assert(!html.includes("Booking Window"));
    });

    test("admin listing edit page pre-fills daily config", async () => {
      const { listing } = await setupListingAndLogin({
        bookableDays: ["Wednesday", "Friday"],
        listingType: "daily",
        maximumDaysAfter: 120,
        minimumDaysBefore: 5,
      });

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="Wednesday" checked',
        'value="Friday" checked',
        'value="5"',
        'value="120"',
      );
      assert(!html.includes('value="Monday" checked'));
    });

    test("updates listing from standard to daily", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, {
        bookableDays: ["Saturday", "Sunday"],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.listingType).toBe("daily");
      expect(updated?.bookableDays).toEqual(["Saturday", "Sunday"]);
      expect(updated?.minimumDaysBefore).toBe(0);
      expect(updated?.maximumDaysAfter).toBe(14);
    });

    test("updates listing from daily to standard", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maximumDaysAfter: 365,
        minimumDaysBefore: 7,
      });
      await updateTestListing(listing.id, { listingType: "standard" });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.listingType).toBe("standard");
    });

    test("duplicate page pre-fills daily listing config", async () => {
      await setupListingAndLogin({
        bookableDays: ["Tuesday", "Thursday"],
        listingType: "daily",
        maximumDaysAfter: 45,
        minimumDaysBefore: 2,
      });

      const html = await assertAdminHtml(
        "/admin/listing/1/duplicate",
        'value="Tuesday" checked',
        'value="Thursday" checked',
        'value="2"',
        'value="45"',
      );
      assert(!html.includes('value="Monday" checked'));
    });

    test("rejects invalid listing_type value", async () => {
      const { response } = await submitListingCreate({
        listingType: "invalid",
        name: "Bad Type Listing",
      });
      expectStatus(400)(response);
    });

    test("creates listing with non_transferable flag", async () => {
      const listing = await createTestListing({ nonTransferable: true });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.nonTransferable).toBe(true);
    });

    test("creates listing without non_transferable by default", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.nonTransferable).toBe(false);
    });

    test("admin listing detail page shows non-transferable row when enabled", async () => {
      const { listing } = await setupListingAndLogin({
        nonTransferable: true,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Non-Transferable",
        "ID verification required at entry",
      );
    });

    test("admin listing detail page does not show non-transferable row when disabled", async () => {
      const { listing } = await setupListingAndLogin();

      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      assert(!html.includes("Non-Transferable"));
    });

    test("admin listing edit page pre-fills non-transferable select", async () => {
      const { listing } = await setupListingAndLogin({
        nonTransferable: true,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        "Non-transferable items",
        'value="1" selected',
      );
    });

    test("updates listing to enable non_transferable", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, { nonTransferable: true });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.nonTransferable).toBe(true);
    });

    test("rejects invalid bookable_days value", async () => {
      await setupListingAndLogin({
        name: "Edit Target",
      });

      const listing = (await getListingWithCount(1))!;

      const { response } = await submitListingEdit(1, {
        bookableDays: "Funday,Bunday",
        listingType: "daily",
        maximumDaysAfter: "90",
        minimumDaysBefore: "1",
        name: "Edit Target",
        slug: listing.slug,
      });
      await expectHtmlResponse(response, 400, "Invalid day");
    });

    test("saves an empty bookable-days selection for a daily listing", async () => {
      const listing = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        name: "Daily Edit Target",
      });

      await updateTestListing(listing.id, { bookableDays: [] });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.bookableDays).toEqual([]);
    });
  });
});
