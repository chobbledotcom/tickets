// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { appendImageToItem, imagesTable } from "#shared/db/images.ts";
import { settings } from "#shared/db/settings.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { assertPublicHtml, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > listings display",
  { db: true, triggers: true },
  () => {
    describe("GET /listings", () => {
      /** Creates a standalone listing (to keep /listings non-empty) then
       * asserts a group/package's Book CTA is absent from the public
       * listings page — the shared tail of every "suppress the CTA"
       * scenario (no active members, sold-out member, inactive member, no
       * members at all). */
      const expectGroupCtaSuppressed = async (
        group: { slug: string },
        groupName: string,
      ): Promise<void> => {
        await createTestListing({
          maxAttendees: 50,
          name: "Standalone Listing",
        });
        const html = await assertPublicHtml("/listings", "Standalone Listing");
        expect(html).not.toContain(`href="/ticket/${group.slug}"`);
        expect(html).not.toContain(groupName);
      };

      test("redirects legacy /events to /listings when public site is enabled", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(mockRequest("/events"));
        expectRedirect(response, /^\/listings$/);
      });

      test("does not redirect legacy /events subpaths", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(mockRequest("/events/archive"));
        expect(response.status).toBe(404);
      });

      test("redirects to admin when public site is disabled", async () => {
        const response = await handleRequest(mockRequest("/listings"));
        expectRedirect(response, /^\/admin\/login$/);
      });

      test("shows no listings message when enabled but no listings exist", async () => {
        await settings.update.showPublicSite(true);
        const html = await assertPublicHtml("/listings", "No listings listed.");
        // The login footer is a homepage-only affordance (#69) — /listings
        // never shows it.
        expect(html).not.toContain('href="/admin/login"');
      });

      test("shows website title with no listings message", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.websiteTitle("My Listings");
        await assertPublicHtml(
          "/listings",
          "No listings listed.",
          "My Listings",
        );
      });

      test("shows active listings with book now links", async () => {
        await settings.update.showPublicSite(true);
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Concert",
        });
        await assertPublicHtml(
          "/listings",
          listing.name,
          "Book now",
          `href="/ticket/${listing.slug}"`,
        );
      });

      test("shows Buy now link for purchase_only listings", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({
          maxAttendees: 100,
          name: "Raffle",
          purchaseOnly: true,
        });
        const html = await assertPublicHtml("/listings", "Raffle", "Buy now");
        expect(html).not.toContain("Book now");
      });

      test("does not show inactive listings", async () => {
        await settings.update.showPublicSite(true);
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Hidden Listing",
        });
        await deactivateTestListing(listing.id);
        const html = await assertPublicHtml("/listings", "No listings listed.");
        expect(html).not.toContain("Hidden Listing");
      });

      test("does not show hidden listings in public listings list", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({ hidden: true, name: "Secret Listing" });
        const html = await assertPublicHtml("/listings", "No listings listed.");
        expect(html).not.toContain("Secret Listing");
      });

      test("shows non-hidden listings alongside hidden ones", async () => {
        await settings.update.showPublicSite(true);
        await createTestListing({ name: "Visible Listing" });
        await createTestListing({ hidden: true, name: "Secret Listing" });
        const html = await assertPublicHtml("/listings", "Visible Listing");
        expect(html).not.toContain("Secret Listing");
      });

      test("hidden listing is still accessible via direct ticket URL", async () => {
        const listing = await createTestListing({
          hidden: true,
          name: "Secret Listing",
        });
        await assertPublicHtml(`/ticket/${listing.slug}`, "Secret Listing");
      });

      test("hidden listing ticket page has noindex x-robots-tag", async () => {
        const listing = await createTestListing({ hidden: true });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      });

      test("non-hidden listing ticket page has index x-robots-tag", async () => {
        const listing = await createTestListing();
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        expect(response.headers.get("x-robots-tag")).toBe("index, follow");
      });

      test("x-robots-noindex signal header is not leaked to client", async () => {
        const listing = await createTestListing({ hidden: true });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        expect(response.headers.has("x-robots-noindex")).toBe(false);
      });

      test("shows groups with active listings on listings page", async () => {
        await settings.update.showPublicSite(true);
        const group = await createTestGroup({
          name: "Summer Festival",
          slug: "summer-festival",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Festival Listing",
        });
        await assertPublicHtml(
          "/listings",
          "Summer Festival",
          `href="/ticket/${group.slug}"`,
          "Book now",
        );
      });

      test("lists package groups under a Packages heading above regular ones", async () => {
        await settings.update.showPublicSite(true);
        // Two package groups (out of alpha order) prove the name sort runs.
        const pkgZ = await createTestGroup({
          isPackage: true,
          name: "Zephyr Bundle",
          slug: "zephyr-bundle",
        });
        await createTestListing({
          groupId: pkgZ.id,
          maxAttendees: 50,
          name: "Zephyr Listing",
        });
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Weekend Bundle",
          slug: "weekend-bundle",
        });
        await createTestListing({
          groupId: pkg.id,
          maxAttendees: 50,
          name: "Bundle Listing",
        });
        const regular = await createTestGroup({
          name: "Regular Group",
          slug: "regular-group",
        });
        await createTestListing({
          groupId: regular.id,
          maxAttendees: 50,
          name: "Regular Listing",
        });

        const html = await assertPublicHtml("/listings", "Weekend Bundle");
        // The Packages heading precedes the package groups, sorted by name
        // (Weekend before Zephyr), which precede the "All bookable listings"
        // section that carries the regular group.
        expect(html.indexOf("Packages")).toBeLessThan(
          html.indexOf("Weekend Bundle"),
        );
        expect(html.indexOf("Weekend Bundle")).toBeLessThan(
          html.indexOf("Zephyr Bundle"),
        );
        expect(html.indexOf("Zephyr Bundle")).toBeLessThan(
          html.indexOf("All bookable listings"),
        );
        expect(html.indexOf("All bookable listings")).toBeLessThan(
          html.indexOf("Regular Group"),
        );
      });

      test("suppresses the CTA of a group with no active members on listings page", async () => {
        // A group with no active (standalone-bookable) member has no valid
        // `/ticket/<group>` entry point (its group page 404s), so its Book CTA must
        // be suppressed on /listings rather than advertise a dead link.
        await settings.update.showPublicSite(true);
        const group = await createTestGroup({
          name: "Empty Group",
          slug: "empty-group",
        });
        // A standalone listing keeps the page non-empty so this proves the GROUP
        // CTA is suppressed (not merely the empty-page fallback).
        await expectGroupCtaSuppressed(group, "Empty Group");
      });

      test("suppresses a package CTA when a member is sold out", async () => {
        // A package is all-or-nothing: if any member can't be booked the whole
        // bundle's count caps at 0, so its /listings Book CTA must be suppressed
        // rather than land the buyer on a page that can only fail.
        await settings.update.showPublicSite(true);
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Half Bundle",
          slug: "half-bundle",
        });
        await createTestListing({
          groupId: pkg.id,
          maxAttendees: 50,
          name: "Available Member",
        });
        await createTestListing({
          groupId: pkg.id,
          maxAttendees: 0,
          name: "Sold Out Member",
        });
        await expectGroupCtaSuppressed(pkg, "Half Bundle");
      });

      test("suppresses a package CTA when a member is inactive", async () => {
        // A package is all-or-nothing: an inactive member makes the whole bundle
        // unavailable rather than silently selling only the active subset.
        await settings.update.showPublicSite(true);
        const pkg = await createTestGroup({
          isPackage: true,
          name: "Partial Bundle",
          slug: "partial-bundle",
        });
        await createTestListing({
          groupId: pkg.id,
          maxAttendees: 50,
          name: "Active Member",
        });
        const inactive = await createTestListing({
          groupId: pkg.id,
          maxAttendees: 50,
          name: "Inactive Member",
        });
        await deactivateTestListing(inactive.id);
        await expectGroupCtaSuppressed(pkg, "Partial Bundle");
      });

      test("suppresses a package CTA when the group has no members", async () => {
        await settings.update.showPublicSite(true);
        const empty = await createTestGroup({
          isPackage: true,
          name: "Empty Bundle",
          slug: "empty-bundle",
        });
        await expectGroupCtaSuppressed(empty, "Empty Bundle");
      });

      test("shows group description on listings page", async () => {
        await settings.update.showPublicSite(true);
        const group = await createTestGroup({
          description: "A wonderful summer celebration",
          name: "Described Festival",
          slug: "described-festival",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Described Festival Listing",
        });
        await assertPublicHtml(
          "/listings",
          "Described Festival",
          "A wonderful summer celebration",
        );
      });

      test("does not show hidden groups on listings page", async () => {
        await settings.update.showPublicSite(true);
        const group = await createTestGroup({
          hidden: true,
          name: "Secret Group",
          slug: "secret-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Visible Listing In Hidden Group",
        });
        const html = await assertPublicHtml(
          "/listings",
          "Visible Listing In Hidden Group",
        );
        expect(html).not.toContain("Secret Group");
      });

      test("hidden group is still accessible via direct ticket URL", async () => {
        const group = await createTestGroup({
          hidden: true,
          name: "Hidden Group",
          slug: "hidden-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Hidden Group Listing",
        });
        await assertPublicHtml(`/ticket/${group.slug}`, "Hidden Group");
      });

      test("grouped listings also appear individually on listings page", async () => {
        await settings.update.showPublicSite(true);
        const group = await createTestGroup({
          name: "My Group",
          slug: "my-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Grouped Listing",
        });
        await createTestListing({
          maxAttendees: 50,
          name: "Ungrouped Listing",
        });
        await assertPublicHtml(
          "/listings",
          "My Group",
          "Ungrouped Listing",
          "Grouped Listing",
        );
      });
    });

    describe("public image galleries", () => {
      const twoImages = async (
        itemType: "listing" | "group",
        itemId: number,
      ): Promise<void> => {
        const first = await imagesTable.insert({
          altText: "First alt",
          filename: nonEmptyString("gallery-one.webp"),
          filenameThumb: nonEmptyString("gallery-one-thumb.webp"),
          name: "One",
        });
        const second = await imagesTable.insert({
          altText: "",
          filename: nonEmptyString("gallery-two.webp"),
          filenameThumb: nonEmptyString("gallery-two-thumb.webp"),
          name: "Two",
        });
        await appendImageToItem(first.id, { itemId, itemType });
        await appendImageToItem(second.id, { itemId, itemType });
      };

      test("a single listing's page shows its images as the shared gallery", async () => {
        const listing = await createTestListing({ name: "Illustrated" });
        await twoImages("listing", listing.id);
        const html = await assertPublicHtml(`/ticket/${listing.slug}`);
        expect(html).toContain('class="news-gallery"');
        expect(html).toContain("gallery-one.webp");
        expect(html).toContain('alt="First alt"');
        expect(html).toContain(
          '<label class="news-gallery-thumb" for="news-gallery-1">',
        );
      });

      test("a group's page shows the group's images as the shared gallery", async () => {
        const group = await createTestGroup({ name: "Bundle", slug: "bundle" });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Member",
        });
        await twoImages("group", group.id);
        const html = await assertPublicHtml(`/ticket/${group.slug}`);
        expect(html).toContain('class="news-gallery"');
        expect(html).toContain("gallery-one.webp");
      });
    });
  },
);
