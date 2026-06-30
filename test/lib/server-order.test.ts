import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groupsTable } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assertPublicHtml,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectRedirect,
  expectStatus,
  mockRequest,
} from "#test-utils";

/** GET /order with the given checkbox selection (listing ids). */
const selectOrder = (ids: number[]): Promise<Response> => {
  const query = ids.map((id) => `select_${id}=1`).join("&");
  return handleRequest(mockRequest(`/order?${query}`));
};

const enablePublicOrder = (): void => {
  beforeEach(async () => {
    await settings.update.showPublicSite(true);
    await settings.update.orderEnabled(true);
  });
  afterEach(async () => {
    await settings.update.showPublicSite(false);
    await settings.update.orderEnabled(false);
  });
};

describeWithEnv("server (public order)", { db: true, triggers: true }, () => {
  describe("availability guard", () => {
    test("redirects to admin login when the public site is disabled", async () => {
      await settings.update.orderEnabled(true);
      const response = await handleRequest(mockRequest("/order"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("returns 404 when the order page is disabled", async () => {
      await settings.update.showPublicSite(true);
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
        "View order",
      );
      expect(html).toContain(`name="select_${standard.id}"`);
      expect(html).toContain(`name="select_${daily.id}"`);
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

    test("lists a bookable package as a direct book link, not a cart checkbox", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Camp Bundle",
        slug: "camp-bundle",
      });
      await createTestListing({ groupId: group.id, name: "Bundle Tent" });

      // A package is booked as a whole via its own page, so it surfaces as a
      // direct book link (the order-card--package anchor to /ticket/<group>),
      // under the Packages heading — not a selectable cart checkbox. (Its
      // visible member is still independently selectable in the grid below, the
      // same as on /listings.)
      await assertPublicHtml(
        "/order",
        "Packages",
        "Camp Bundle",
        "order-card--package",
        `href="/ticket/${group.slug}"`,
      );
    });

    test("shows a hidden package's bundle as bookable while its members stay hidden", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Mystery Box",
        slug: "mystery-box",
      });
      await groupsTable.update(group.id, { hidePackageListings: true });
      const secret = await createTestListing({
        groupId: group.id,
        name: "Secret Widget",
      });

      // The bundle is buyable from /order (the package card), even though its
      // sole member is dropped from the selectable grid — so the page is not the
      // empty state and never exposes the member name or a checkbox for it.
      const html = await assertPublicHtml(
        "/order",
        "Mystery Box",
        `/ticket/${group.slug}`,
      );
      expect(html).not.toContain("Secret Widget");
      expect(html).not.toContain(`name="select_${secret.id}"`);
      expect(html).not.toContain("No items are available to order");
    });
  });

  describe("GET /order with a selection (redirect into the booking page)", () => {
    enablePublicOrder();

    test("redirects one selected item into its pre-filled booking page", async () => {
      const item = await createTestListing({ maxQuantity: 5, name: "Widget" });
      const response = await selectOrder([item.id]);
      expectRedirect(response, `/ticket/${item.slug}?q_${item.id}=1`);
    });

    test("redirects multiple items to the multi-listing booking page", async () => {
      const a = await createTestListing({ name: "Alpha" });
      const b = await createTestListing({ name: "Bravo" });
      const location = expectRedirect(await selectOrder([a.id, b.id]));
      expect(location).toContain(a.slug);
      expect(location).toContain(b.slug);
      expect(location).toContain(`q_${a.id}=1`);
      expect(location).toContain(`q_${b.id}=1`);
    });

    test("includes a sold-out pick as a slug but does not pre-fill it", async () => {
      const open = await createTestListing({ name: "In Stock" });
      const sold = await createTestListing({
        maxAttendees: 1,
        name: "No Stock",
      });
      await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");

      const location = expectRedirect(await selectOrder([open.id, sold.id]));
      expect(location).toContain(sold.slug);
      expect(location).toContain(`q_${open.id}=1`);
      expect(location).not.toContain(`q_${sold.id}=1`);
    });

    test("redirects with no pre-fill when every pick is sold out", async () => {
      const sold = await createTestListing({ maxAttendees: 1, name: "Gone" });
      await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");
      const location = expectRedirect(await selectOrder([sold.id]));
      expect(location).toBe(`/ticket/${sold.slug}`);
    });

    test("ignores ids that are not bookable listings and shows the gallery", async () => {
      await createTestListing({ name: "Only Me" });
      // No valid selection → fall through to the gallery, not a redirect.
      const response = await handleRequest(
        mockRequest("/order?select_99999=1"),
      );
      expectStatus(200)(response);
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
