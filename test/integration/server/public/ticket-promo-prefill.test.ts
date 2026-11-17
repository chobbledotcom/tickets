import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { handleRequest } from "#routes";
import { formatCurrency } from "#shared/currency.ts";
import { matchKey } from "#shared/keys.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectIncludesAll,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import {
  capturedModifierQuantity,
  stubCheckout,
} from "#test-utils/checkout.ts";
import {
  extractCsrfToken,
  extractInputValue,
  hasInputWithValue,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { insertModifier } from "#test-utils/modifiers.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** A whole-order 10% discount unlocked by `code`, so the page offers the
 * promo box and the code can be matched at submit. */
const insertPromoModifier = async (code: string) =>
  await insertModifier({
    calcKind: "percent",
    calcValue: 10,
    codeIndex: await hmacHash(matchKey(code)),
    direction: "discount",
    name: code,
    trigger: "code",
  });

/** A free listing plus the "Summer25" promo code — the page a buyer lands on
 * from an operator's `?promo=` link. */
const setupPromoListing = async () => {
  const listing = await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  await insertPromoModifier("Summer25");
  return listing;
};

describeWithEnv(
  "server public > ?promo= prefill",
  { db: true, triggers: true },
  () => {
    test("fills the promo box from the URL without case or spaces", async () => {
      const listing = await setupPromoListing();

      const html = await assertPublicHtml(
        `/ticket/${listing.slug}?promo=%20Summer25%20`,
        'name="promoCode"',
      );

      expect(hasInputWithValue(html, "promoCode", "summer25")).toBe(true);
    });

    test("fills the promo box for an unknown code — matching happens at submit", async () => {
      const listing = await setupPromoListing();

      const html = await assertPublicHtml(
        `/ticket/${listing.slug}?promo=nosuchcode`,
        'name="promoCode"',
      );

      expect(hasInputWithValue(html, "promoCode", "nosuchcode")).toBe(true);
    });

    test("fills the one shared promo box on a multi-listing page", async () => {
      const a = await setupPromoListing();
      const b = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const html = await assertPublicHtml(
        `/ticket/${a.slug}+${b.slug}?promo=summer25`,
        'name="promoCode"',
      );

      expect(html.split('name="promoCode"').length - 1).toBe(1);
      expect(hasInputWithValue(html, "promoCode", "summer25")).toBe(true);
    });

    test("keeps the typed code after a failed submit, not the URL code", async () => {
      const listing = await setupPromoListing();

      // The buyer lands via the operator's link, then types their own code.
      const failed = await submitTicketForm(`${listing.slug}?promo=Summer25`, {
        email: "john@example.com",
        name: "",
        promoCode: "typed99",
      });
      expectFlash(
        failed,
        expect.stringContaining("Your Name is required"),
        false,
      );

      const html = await (
        await followRedirectWithFlash(failed, handleRequest)
      ).text();
      expect(hasInputWithValue(html, "promoCode", "typed99")).toBe(true);
      expect(hasInputWithValue(html, "promoCode", "summer25")).toBe(false);
    });

    test("applies the prefilled code's discount through the submit path", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });
      const promo = await insertPromoModifier("Summer25");

      // The link lands the code in the box; the browser submits what the box
      // holds, so both legs below price the prefilled value itself.
      const html = await assertPublicHtml(
        `/ticket/${listing.slug}?promo=Summer25`,
        'name="promoCode"',
      );
      const sent = extractInputValue(html, "promoCode");
      expect(sent).toBe("summer25");

      // The running total (the same pricing pass submit runs) shows 10% off a
      // £10.00 ticket: the discount line and the £9.00 total.
      const quoteHtml = await (
        await handleRequest(
          mockFormRequest(`/calculate/${listing.slug}`, {
            [`quantity${listing.id}`]: "1",
            csrfToken: extractCsrfToken(html) ?? "",
            promoCode: sent ?? "",
          }),
        )
      ).text();
      expectIncludesAll(quoteHtml, ["Summer25", formatCurrency(900)]);

      // And a paid submit carries the matched promo into the checkout intent.
      const { checkout, getCaptured } = stubCheckout("cs_promo_prefill");
      try {
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
          promoCode: sent ?? "",
        });
        expect(response.status).toBe(302);
        expect(capturedModifierQuantity(getCaptured(), promo.id)).toBe(1);
      } finally {
        checkout.restore();
      }
    });
  },
);
