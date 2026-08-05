import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { enablePublicOrder } from "#test/features/public/order/helpers.ts";
import {
  assertPublicHtml,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

describeWithEnv("server (public order)", { db: true, triggers: true }, () => {
  describe("availability guard", () => {
    test("redirects to admin login when the public site is disabled", async () => {
      await settings.update.orderEnabled(true);
      const response = await handleRequest(mockRequest("/order"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("returns 404 when the order page is disabled", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/order"));
      expectStatus(404)(response);
    });
  });

  describe("GET /order (gallery)", () => {
    enablePublicOrder();

    test("shows a selectable grid of every bookable listing", async () => {
      const standard = await createTestListing({ name: "Branded Mug" });
      const daily = await createTestListing({
        bookableDays: ["Monday", "Tuesday", "Wednesday"],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name: "Day Pass",
      });
      const html = await assertPublicHtml(
        "/order",
        "Branded Mug",
        "Day Pass",
        'class="order-gallery"',
        'method="get"',
        'class="order-cart"',
        'class="order-continue"',
        "View order",
        "Continue",
      );
      expect(html).toContain(`name="select_${standard.id}"`);
      expect(html).toContain(`name="select_${daily.id}"`);
      // The login footer is a homepage-only affordance (#69).
      expect(html).not.toContain('href="/admin/login"');
    });

    test("renders the intro text as markdown", async () => {
      await createTestListing({ name: "Tote" });
      await settings.update.orderIntroText("**Pick** your items");
      const html = await assertPublicHtml("/order");
      expect(html).toContain("<strong>Pick</strong>");
    });

    test("shows an empty state and no cart when there are no listings", async () => {
      const html = await assertPublicHtml(
        "/order",
        "No items are available to order",
      );
      expect(html).not.toContain('class="order-cart"');
      expect(html).not.toContain('class="order-continue"');
    });

    test("excludes hidden and inactive listings", async () => {
      await createTestListing({ name: "Real Item" });
      await createTestListing({ hidden: true, name: "Hidden Item" });
      const inactive = await createTestListing({ name: "Inactive Item" });
      await deactivateTestListing(inactive.id);

      const html = await assertPublicHtml("/order", "Real Item");
      expect(html).not.toContain("Hidden Item");
      expect(html).not.toContain("Inactive Item");
    });

    test("shows the Order link in the public nav when enabled", async () => {
      const html = await assertPublicHtml("/listings");
      expect(html).toContain('href="/order"');
    });

    test("shows the website title as a heading", async () => {
      await createTestListing({ name: "Tote" });
      await settings.update.websiteTitle("Acme Shop");
      const html = await assertPublicHtml("/order");
      expect(html).toContain("<h1>Acme Shop</h1>");
    });

    test("shows a price for priced listings", async () => {
      await createTestListing({ name: "Priced", unitPrice: 1500 });
      const html = await assertPublicHtml("/order");
      expect(html).toContain('class="order-card-price"');
    });

    test("shows a 'From' price for pay-what-you-want listings", async () => {
      await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation",
        unitPrice: 1000,
      });
      const html = await assertPublicHtml("/order");
      expect(html).toContain("From ");
    });

    test("shows selected listing attributes on order cards", async () => {
      const listing = await createTestListing({ name: "Badge Card" });
      const format = await createTestAttributeWithOptions("Format", ["Online"]);
      await assignTestAttributeOptions(listing.id, format.options);

      await assertPublicHtml(
        "/order",
        "Badge Card",
        "listing-attributes",
        "Format",
        "Online",
      );
    });

    test("marks a sold-out listing as unavailable and non-selectable", async () => {
      const sold = await createTestListing({ maxAttendees: 1, name: "Gone" });
      await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");
      const html = await assertPublicHtml("/order", "Gone", "Sold Out");
      expect(html).not.toContain(`name="select_${sold.id}"`);
    });

    test("marks a closed listing as unavailable", async () => {
      await createTestListing({ closesAt: "2020-01-01T00:00", name: "Past" });
      const html = await assertPublicHtml("/order", "Past", "Unavailable");
      expect(html).not.toContain("Sold Out");
    });

    test("lists bookable packages as selectable cards under a Packages heading", async () => {
      // Two packages so the name sort actually runs (a single-element sort never
      // invokes the comparator).
      const camp = await createTestGroup({
        isPackage: true,
        name: "Camp Bundle",
        slug: "camp-bundle",
      });
      const tent = await createTestListing({
        groupId: camp.id,
        name: "Bundle Tent",
      });
      const beach = await createTestGroup({
        isPackage: true,
        name: "Beach Bundle",
        slug: "beach-bundle",
      });
      await createTestListing({ groupId: beach.id, name: "Bundle Towel" });

      // A package is a cart checkbox exactly like a listing card, so one order
      // can carry several bundles alongside ordinary listings. Their visible
      // members are still independently selectable in the grid below, the same
      // as on /listings.
      const html = await assertPublicHtml(
        "/order",
        "Packages",
        "Camp Bundle",
        "Beach Bundle",
        `name="select_package_${camp.id}"`,
        `name="select_package_${beach.id}"`,
        `data-order-key="package:${camp.id}"`,
      );
      expect(html).toContain(`name="select_${tent.id}"`);
    });

    test("the whole gallery is one cart form with live-availability hooks", async () => {
      const item = await createTestListing({ name: "Hook Item" });
      // data-order-gallery is the enhancement script's mount point; the hidden
      // order field records the order things were added in.
      const html = await assertPublicHtml(
        "/order",
        "data-order-gallery",
        `name="order"`,
        "data-order-state-label",
      );
      expect(html).toContain(`data-order-key="listing:${item.id}"`);
    });

    test("renders the date prompt and needs-date labels for daily items", async () => {
      await createDailyTestListing({ name: "Day Pass" });
      await createTestListing({ name: "Dateless Mug" });
      // A daily card can't be judged without a date, so it says so server-side
      // and the date field renders for the visitor to pick one up front.
      const html = await assertPublicHtml(
        "/order",
        'name="start_date"',
        "Have a date in mind?",
        "Pick a date to see availability",
      );
      expect(html).toContain("data-order-date");
    });

    test("omits the date field when nothing on the page needs a date", async () => {
      await createTestListing({ name: "Dateless Mug" });
      const html = await assertPublicHtml("/order");
      expect(html).not.toContain('name="start_date"');
    });

    test("shows a hidden package's bundle as bookable while its members stay hidden", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Mystery Box",
        slug: "mystery-box",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const secret = await createTestListing({
        groupId: group.id,
        name: "Secret Widget",
      });

      // The bundle is buyable from /order (the package card), even though its
      // sole member is dropped from the selectable grid — so the page is not the
      // empty state and never exposes the member name or a checkbox for it.
      const html = await assertPublicHtml("/order", "Mystery Box");
      expect(html).toContain(`name="select_package_${group.id}"`);
      expect(html).not.toContain("Secret Widget");
      expect(html).not.toContain(`name="select_${secret.id}"`);
      expect(html).not.toContain("No items are available to order");
    });
  });

  describe("?q_<id> quantity pre-fill on the booking page", () => {
    test("pre-selects the requested quantity on a single-listing page", async () => {
      const item = await createTestListing({ maxQuantity: 5, name: "Widget" });
      const html = await assertPublicHtml(
        `/ticket/${item.slug}?q_${item.id}=2`,
        `name="quantity_${item.id}"`,
      );
      expect(html).toContain("selected>2</option>");
    });

    test("pre-selects quantities per row on a multi-listing page", async () => {
      const a = await createTestListing({ maxQuantity: 5, name: "Alpha" });
      const b = await createTestListing({ maxQuantity: 5, name: "Bravo" });
      const html = await assertPublicHtml(
        `/ticket/${a.slug}+${b.slug}?q_${a.id}=2`,
        `name="quantity_${a.id}"`,
        `name="quantity_${b.id}"`,
      );
      // Row A is pre-filled to 2; row B has no q param so stays unselected.
      expect(html).toContain("selected>2</option>");
    });

    test("ignores malformed quantity pre-fill values", async () => {
      const item = await createTestListing({ maxQuantity: 5, name: "Widget" });
      const html = await assertPublicHtml(
        `/ticket/${item.slug}?q_${item.id}=2x`,
        `name="quantity_${item.id}"`,
      );
      expect(html).not.toContain("selected>2</option>");
    });
  });
});
