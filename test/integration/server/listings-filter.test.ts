import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const get = (path: string) => handleRequest(mockRequest(path));

const DAILY = {
  bookableDays: ["Monday", "Tuesday", "Wednesday"],
  listingType: "daily" as const,
  maximumDaysAfter: 14,
  minimumDaysBefore: 0,
};

describeWithEnv("listings type filter", { db: true }, () => {
  describe("admin listings dashboard", () => {
    test("shows the type filter when more than one type is present", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin");
      const html = await response.text();
      expect(html).toContain("Showing:");
      expect(html).toContain("Standard");
      expect(html).toContain("Daily");
      expect(html).toContain('href="/admin/?type=standard"');
    });

    test("hides the type filter when only one type is present", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Standard Two" });
      const response = await adminGet("/admin");
      const html = await response.text();
      expect(html).not.toContain("Showing:");
    });

    // The table is the only place that links a listing to /admin/listing/:id
    // (the multi-booking builder below the table uses slugs), so asserting on
    // that link proves the table itself was filtered.
    test("filters the listing table to standard listings", async () => {
      const standard = await createTestListing({ name: "Standard One" });
      const daily = await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin?type=standard");
      const html = await response.text();
      expect(html).toContain(`href="/admin/listing/${standard.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${daily.id}"`);
      // Active filter is bold + underlined; others remain links.
      expect(html).toContain("<strong><u>Standard</u></strong>");
      expect(html).toContain('href="/admin/?type=daily"');
    });

    test("filters the listing table to daily listings", async () => {
      const standard = await createTestListing({ name: "Standard One" });
      const daily = await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin?type=daily");
      const html = await response.text();
      expect(html).toContain(`href="/admin/listing/${daily.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${standard.id}"`);
      expect(html).toContain("<strong><u>Daily</u></strong>");
    });

    test("filters the listing table to purchase-only listings", async () => {
      const standard = await createTestListing({ name: "Standard One" });
      const merch = await createTestListing({
        name: "Merch",
        purchaseOnly: true,
      });
      const response = await adminGet("/admin?type=purchase-only");
      const html = await response.text();
      expect(html).toContain(`href="/admin/listing/${merch.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${standard.id}"`);
      expect(html).toContain("No check-in");
    });

    test("treats an unknown type as 'all'", async () => {
      const standard = await createTestListing({ name: "Standard One" });
      const daily = await createTestListing({ name: "Daily One", ...DAILY });
      const response = await adminGet("/admin?type=bogus");
      const html = await response.text();
      expect(html).toContain(`href="/admin/listing/${standard.id}"`);
      expect(html).toContain(`href="/admin/listing/${daily.id}"`);
      expect(html).toContain("<strong><u>All</u></strong>");
    });

    test("filters the listing table by selected listing attribute", async () => {
      const easyListing = await createTestListing({ name: "Easy Listing" });
      const hardListing = await createTestListing({ name: "Hard Listing" });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await assignTestAttributeOptions(easyListing.id, [
        difficulty.options[0]!,
      ]);
      await assignTestAttributeOptions(hardListing.id, [
        difficulty.options[1]!,
      ]);

      const response = await adminGet(
        `/admin?attribute_${difficulty.id}=${difficulty.options[0]!.id}`,
      );
      const html = await response.text();

      expect(html).toContain(`href="/admin/listing/${easyListing.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${hardListing.id}"`);
      expect(html).toContain("Difficulty:");
      expect(html).toContain("<strong><u>Easy</u></strong>");
      expect(html).toContain(
        `attribute_${difficulty.id}=${difficulty.options[1]!.id}`,
      );
    });

    test("keeps attribute filters in type links and type filters in attribute links", async () => {
      const standard = await createTestListing({ name: "Standard Easy" });
      const daily = await createTestListing({ name: "Daily Hard", ...DAILY });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await assignTestAttributeOptions(standard.id, [difficulty.options[0]!]);
      await assignTestAttributeOptions(daily.id, [difficulty.options[1]!]);

      const response = await adminGet(
        `/admin?type=daily&attribute_${difficulty.id}=${
          difficulty.options[1]!.id
        }`,
      );
      const html = await response.text();

      expect(html).toContain(
        `/admin/?type=standard&attribute_${difficulty.id}=${
          difficulty.options[1]!.id
        }`,
      );
      expect(html).toContain(`href="/admin/?type=daily">All</a>`);
    });
  });

  describe("admin listings index", () => {
    const setupFilteredPair = async (labels: [string, string]) => {
      const shown = await createTestListing({ name: labels[0] });
      const hidden = await createTestListing({ name: labels[1] });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await assignTestAttributeOptions(shown.id, [difficulty.options[0]!]);
      await assignTestAttributeOptions(hidden.id, [difficulty.options[1]!]);
      return { difficulty, hidden, shown };
    };

    const filterUrl = (
      path: string,
      attributeId: number,
      optionId: number,
    ): string => `${path}?attribute_${attributeId}=${optionId}`;

    test("filters listings by selected listing attribute", async () => {
      const { shown, hidden, difficulty } = await setupFilteredPair([
        "Shown",
        "Hidden",
      ]);

      const response = await adminGet(
        filterUrl("/admin/listings", difficulty.id, difficulty.options[0]!.id),
      );
      const html = await response.text();

      expect(html).toContain(`href="/admin/listing/${shown.id}"`);
      expect(html).not.toContain(`href="/admin/listing/${hidden.id}"`);
    });

    test("CSV export link carries the active attribute filter", async () => {
      const listing = await createTestListing({ name: "Filtered CSV" });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
      ]);
      await assignTestAttributeOptions(listing.id, difficulty.options);

      const response = await adminGet(
        filterUrl("/admin/listings", difficulty.id, difficulty.options[0]!.id),
      );
      const html = await response.text();
      const filterParam = `attribute_${difficulty.id}=${
        difficulty.options[0]!.id
      }`;
      expect(html).toContain(`href="/admin/listings/csv?${filterParam}"`);
    });

    test("CSV export respects attribute filter", async () => {
      const { difficulty } = await setupFilteredPair([
        "CSV Shown",
        "CSV Hidden",
      ]);

      const response = await adminGet(
        filterUrl(
          "/admin/listings/csv",
          difficulty.id,
          difficulty.options[0]!.id,
        ),
      );
      const csv = await response.text();

      expect(csv).toContain("CSV Shown");
      expect(csv).not.toContain("CSV Hidden");
    });
  });

  describe("public listings page", () => {
    beforeEach(async () => {
      await enablePublicSite();
    });

    test("lists every type together without a filter bar", async () => {
      await createTestListing({ name: "Standard One" });
      await createTestListing({ name: "Daily One", ...DAILY });
      const html = await expectHtmlResponse(
        await get("/listings"),
        200,
        "Standard One",
        "Daily One",
      );
      expect(html).not.toContain("Showing:");
    });

    test("shows selected listing attributes on listing cards", async () => {
      const listing = await createTestListing({ name: "Attribute Card" });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
      ]);
      await assignTestAttributeOptions(listing.id, difficulty.options);

      const html = await expectHtmlResponse(
        await get("/listings"),
        200,
        "Attribute Card",
        "listing-attributes",
        "Difficulty",
        "Easy",
      );
      expect(html).not.toContain("Showing:");
    });

    test("shows selected listing attributes on a single ticket page", async () => {
      const listing = await createTestListing({ name: "Ticket Attribute" });
      const difficulty = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
      ]);
      await assignTestAttributeOptions(listing.id, difficulty.options);

      await expectHtmlResponse(
        await get(`/ticket/${listing.slug}`),
        200,
        "Ticket Attribute",
        "listing-attributes",
        "Difficulty",
        "Easy",
      );
    });

    test("shows each listing's attributes on a multi-listing ticket page", async () => {
      const listing1 = await createTestListing({ name: "Multi Attribute One" });
      const listing2 = await createTestListing({ name: "Multi Attribute Two" });
      const format = await createTestAttributeWithOptions("Format", [
        "In person",
      ]);
      const audience = await createTestAttributeWithOptions("Audience", [
        "Adults",
      ]);
      await assignTestAttributeOptions(listing1.id, format.options);
      await assignTestAttributeOptions(listing2.id, audience.options);

      await expectHtmlResponse(
        await get(`/ticket/${listing1.slug}+${listing2.slug}`),
        200,
        "Multi Attribute One",
        "Multi Attribute Two",
        "listing-attributes",
        "Format",
        "In person",
        "Audience",
        "Adults",
      );
    });
  });
});
