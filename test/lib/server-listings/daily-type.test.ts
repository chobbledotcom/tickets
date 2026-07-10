// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
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
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

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
      expect(saved?.listing_type).toBe("daily");
      expect(saved?.bookable_days).toEqual(["Monday", "Wednesday", "Friday"]);
      expect(saved?.minimum_days_before).toBe(2);
      expect(saved?.maximum_days_after).toBe(30);
    });

    test("creates standard listing with default daily config", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.listing_type).toBe("standard");
      expect(saved?.bookable_days).toEqual([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
      expect(saved?.minimum_days_before).toBe(1);
      expect(saved?.maximum_days_after).toBe(90);
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
      expect(html).not.toContain("Bookable Days");
      expect(html).not.toContain("Booking Window");
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
      expect(html).not.toContain('value="Monday" checked');
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
      expect(updated?.listing_type).toBe("daily");
      expect(updated?.bookable_days).toEqual(["Saturday", "Sunday"]);
      expect(updated?.minimum_days_before).toBe(0);
      expect(updated?.maximum_days_after).toBe(14);
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
      expect(updated?.listing_type).toBe("standard");
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
      expect(html).not.toContain('value="Monday" checked');
    });

    test("rejects invalid listing_type value", async () => {
      const { response } = await adminFormPost("/admin/listing", {
        listing_type: "invalid",
        max_attendees: "50",
        max_quantity: "1",
        name: "Bad Type Listing",
        thank_you_url: "https://example.com",
      });
      expectStatus(400)(response);
    });

    test("creates listing with non_transferable flag", async () => {
      const listing = await createTestListing({ nonTransferable: true });

      const saved = await getListingWithCount(listing.id);
      expect(saved?.non_transferable).toBe(true);
    });

    test("creates listing without non_transferable by default", async () => {
      const listing = await createTestListing();

      const saved = await getListingWithCount(listing.id);
      expect(saved?.non_transferable).toBe(false);
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
      expect(html).not.toContain("Non-Transferable");
    });

    test("admin listing edit page pre-fills non-transferable select", async () => {
      const { listing } = await setupListingAndLogin({
        nonTransferable: true,
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        "Non-Transferable Tickets",
        'value="1" selected',
      );
    });

    test("updates listing to enable non_transferable", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, { nonTransferable: true });

      const updated = await getListingWithCount(listing.id);
      expect(updated?.non_transferable).toBe(true);
    });

    test("rejects invalid bookable_days value", async () => {
      await setupListingAndLogin({
        name: "Edit Target",
      });

      const listing = (await getListingWithCount(1))!;

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        bookable_days: "Funday,Bunday",
        listing_type: "daily",
        max_attendees: "50",
        max_quantity: "1",
        maximum_days_after: "90",
        minimum_days_before: "1",
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
      expect(updated?.bookable_days).toEqual([]);
    });
  });
});
