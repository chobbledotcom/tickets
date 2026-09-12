import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { followRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  extractCsrfToken,
  extractInputValue,
  submitMultiTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { createSave10Promo } from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** A listing plus the shared SAVE10 code-triggered modifier, so the booking
 * page shows the promo box and the code answers a real discount. */
const setupPromoListing = async () => {
  await setupStripe();
  const listing = await createTestListing({
    maxQuantity: 5,
    name: "Workshop",
    unitPrice: 1000,
  });
  await createSave10Promo();
  return listing;
};

/** The rendered promo box value on a GET, or null when the page has no box. */
const promoBoxValue = async (path: string): Promise<string | null> => {
  const response = await handleRequest(mockRequest(path));
  expect(response.status).toBe(200);
  return extractInputValue(await response.text(), "promo_code");
};

describeWithEnv(
  "server public > ticket promo prefill",
  { db: true, triggers: true },
  () => {
    describe("GET /ticket/:slug?promo=", () => {
      test("fills the promo code box from the URL parameter", async () => {
        const listing = await setupPromoListing();
        expect(
          await promoBoxValue(`/ticket/${listing.slug}?promo=SAVE10`),
        ).toBe("SAVE10");
      });

      test("trims surrounding spaces off the URL code", async () => {
        const listing = await setupPromoListing();
        expect(
          await promoBoxValue(`/ticket/${listing.slug}?promo=%20save10%20`),
        ).toBe("save10");
      });

      test("treats a blank URL code as no prefill", async () => {
        const listing = await setupPromoListing();
        expect(await promoBoxValue(`/ticket/${listing.slug}?promo=%20`)).toBe(
          "",
        );
      });

      test("fills the one shared promo box on a multi-listing URL", async () => {
        const listing1 = await createTestListing({ name: "Promo Page One" });
        const listing2 = await createTestListing({ name: "Promo Page Two" });
        await createSave10Promo();
        const html = await (
          await handleRequest(
            mockRequest(
              `/ticket/${listing1.slug}+${listing2.slug}?promo=summer-sale`,
            ),
          )
        ).text();
        expect((html.match(/name="promo_code"/g) ?? []).length).toBe(1);
        expect(extractInputValue(html, "promo_code")).toBe("summer-sale");
      });
    });

    test("keeps the typed code after a failed submit", async () => {
      const listing = await setupPromoListing();
      // A missing name fails validation; the page that follows the redirect
      // must still hold the code the buyer typed, not an empty box.
      const response = await submitMultiTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "buyer@example.com",
        name: "",
        promo_code: "typed-code",
      });
      expect(response.status).toBe(302);
      const page = await followRedirectWithFlash(response, handleRequest);
      const html = await page.text();
      expect(extractInputValue(html, "promo_code")).toBe("typed-code");
    });

    test("a code from the URL reaches the discounted quote", async () => {
      const listing = await setupPromoListing();
      const page = await handleRequest(
        mockRequest(`/ticket/${listing.slug}?promo=SAVE10`),
      );
      const html = await page.text();
      // Quote with exactly the value the box holds, as the browser would.
      const quote = await handleRequest(
        mockFormRequest(`/calculate/${listing.slug}`, {
          [`quantity_${listing.id}`]: "1",
          csrf_token: extractCsrfToken(html) ?? "",
          promo_code: extractInputValue(html, "promo_code") ?? "",
        }),
      );
      const quoteHtml = await quote.text();
      expect(quoteHtml).toContain("SAVE10");
      expect(quoteHtml).toContain(formatCurrency(900));
    });
  },
);
