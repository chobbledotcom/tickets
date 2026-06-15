import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  expectStatus,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

/** Create a purchase-only product available for quoting. */
const createProduct = (name: string, overrides = {}) =>
  createTestListing({
    maxQuantity: 5,
    name,
    purchaseOnly: true,
    unitPrice: 1500,
    ...overrides,
  });

/** POST a selection of listing ids to /quote with a valid CSRF token. */
const postQuote = async (
  selected: number[],
  extra: Record<string, string> = {},
): Promise<Response> => {
  const csrf = await signCsrfToken();
  const body: Record<string, string> = { csrf_token: csrf, ...extra };
  for (const id of selected) body[`select_${id}`] = "1";
  return handleRequest(mockFormRequest("/quote", body));
};

describeWithEnv("server (public quote)", { db: true }, () => {
  describe("availability guard", () => {
    test("redirects to admin login when the public site is disabled", async () => {
      await settings.update.quoteEnabled(true);
      const response = await handleRequest(mockRequest("/quote"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("returns 404 when quotes are disabled", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/quote"));
      expectStatus(404)(response);
    });

    test("POST returns 404 when quotes are disabled", async () => {
      await settings.update.showPublicSite(true);
      const response = await postQuote([]);
      expectStatus(404)(response);
    });
  });

  describe("GET /quote (gallery)", () => {
    beforeEach(async () => {
      await settings.update.showPublicSite(true);
      await settings.update.quoteEnabled(true);
    });
    afterEach(async () => {
      await settings.update.showPublicSite(false);
      await settings.update.quoteEnabled(false);
    });

    test("shows a selectable grid of purchase-only products", async () => {
      const mug = await createProduct("Branded Mug");
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "Branded Mug",
        'class="quote-gallery"',
        'class="quote-grid"',
        'class="quote-cart"',
        "Request a quote",
      );
      expect(html).toContain(`name="select_${mug.id}"`);
    });

    test("renders the intro text as markdown", async () => {
      await createProduct("Tote Bag");
      await settings.update.quoteIntroText("**Pick** your items");
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
      );
      expect(html).toContain("<strong>Pick</strong>");
    });

    test("shows the website title as a heading", async () => {
      await createProduct("Tote Bag");
      await settings.update.websiteTitle("Acme Shop");
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
      );
      expect(html).toContain("<h1>Acme Shop</h1>");
    });

    test("shows a 'From' price for pay-what-you-want products", async () => {
      await createProduct("Donation", { canPayMore: true, maxPrice: 5000 });
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
      );
      expect(html).toContain("From ");
    });

    test("omits the price for free products", async () => {
      await createProduct("Freebie", { unitPrice: 0 });
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "Freebie",
      );
      expect(html).not.toContain("quote-card-price");
    });

    test("marks closed products as unavailable", async () => {
      await createProduct("Closed Item", { closesAt: "2020-01-01T00:00" });
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "Closed Item",
        "Unavailable",
      );
      expect(html).not.toContain("Sold Out");
    });

    test("shows an empty state and no cart when there are no products", async () => {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "No products are available to quote",
      );
      expect(html).not.toContain('class="quote-cart"');
    });

    test("excludes non-purchase-only, hidden, and inactive listings", async () => {
      await createProduct("Real Product");
      await createTestListing({ name: "Plain Ticket" });
      await createProduct("Hidden Product", { hidden: true });
      const inactive = await createProduct("Inactive Product");
      await deactivateTestListing(inactive.id);

      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "Real Product",
      );
      expect(html).not.toContain("Plain Ticket");
      expect(html).not.toContain("Hidden Product");
      expect(html).not.toContain("Inactive Product");
    });

    test("marks sold-out products as unavailable and non-selectable", async () => {
      const limited = await createProduct("Limited Item", { maxAttendees: 1 });
      await createTestAttendee(
        limited.id,
        limited.slug,
        "Buyer",
        "buyer@example.com",
      );
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/quote")),
        200,
        "Limited Item",
        "Sold Out",
      );
      expect(html).not.toContain(`name="select_${limited.id}"`);
    });

    test("shows the Quotes link in the public nav when enabled", async () => {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/listings")),
        200,
      );
      expect(html).toContain('href="/quote"');
    });
  });

  describe("POST /quote (booking page)", () => {
    beforeEach(async () => {
      await settings.update.showPublicSite(true);
      await settings.update.quoteEnabled(true);
    });
    afterEach(async () => {
      await settings.update.showPublicSite(false);
      await settings.update.quoteEnabled(false);
    });

    test("rejects an invalid CSRF token with a PRG redirect", async () => {
      const response = await handleRequest(
        mockFormRequest("/quote", { csrf_token: "invalid", select_1: "1" }),
      );
      expectRedirect(response, "/quote");
      expectFlash(response, expect.stringContaining("Invalid"), false);
    });

    test("redirects with an error when nothing is selected", async () => {
      await createProduct("Anything");
      const response = await postQuote([]);
      expectRedirectWithFlash(
        "/quote",
        "Please select at least one product",
        false,
      )(response);
    });

    test("renders a booking page for the selected products", async () => {
      const a = await createProduct("Alpha Widget");
      const b = await createProduct("Bravo Widget");

      const html = await expectHtmlResponse(
        await postQuote([a.id, b.id]),
        200,
        "Request a Quote",
        "Alpha Widget",
        "Bravo Widget",
      );
      // The booking form submits through the normal multi-listing ticket path.
      expect(html).toContain('action="/ticket/');
      expect(html).toContain(a.slug);
      expect(html).toContain(b.slug);
    });

    test("pre-selects quantity 1 for each chosen product", async () => {
      const a = await createProduct("Quantity One");
      const b = await createProduct("Quantity Two");

      const html = await expectHtmlResponse(await postQuote([a.id, b.id]), 200);
      // quantityOptions renders `<option value="1" selected>1</option>` per row.
      expect(html).toContain(`name="quantity_${a.id}"`);
      expect(html).toContain(`name="quantity_${b.id}"`);
      const prefilled = html.match(/selected>1<\/option>/g) ?? [];
      expect(prefilled.length).toBe(2);
    });

    test("ignores ids that are not quotable products", async () => {
      const product = await createProduct("Only Me");
      const plain = await createTestListing({ name: "Not Quotable" });

      // Selecting a non-product id alongside nothing valid → no selection.
      const response = await postQuote([plain.id]);
      expectRedirectWithFlash(
        "/quote",
        "Please select at least one product",
        false,
      )(response);

      // Selecting the product plus a junk id still books just the product.
      const html = await expectHtmlResponse(
        await postQuote([product.id, plain.id]),
        200,
        "Only Me",
      );
      expect(html).not.toContain("Not Quotable");
    });

    test("does not pre-fill a sold-out product but still renders it", async () => {
      const open = await createProduct("Open Stock");
      const sold = await createProduct("No Stock", { maxAttendees: 1 });
      await createTestAttendee(sold.id, sold.slug, "Buyer", "b@example.com");

      const html = await expectHtmlResponse(
        await postQuote([open.id, sold.id]),
        200,
        "Open Stock",
        "No Stock",
        "Sold Out",
      );
      // Only the available product gets a pre-selected quantity.
      const prefilled = html.match(/selected>1<\/option>/g) ?? [];
      expect(prefilled.length).toBe(1);
      expect(html).not.toContain(`name="quantity_${sold.id}"`);
    });
  });
});
