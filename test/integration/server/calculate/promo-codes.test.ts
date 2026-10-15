/** Promo-code quotes on the `/calculate` running total: a real code
 * discounts the total, an absent or wrong code changes nothing, and the
 * ticket line keeps the list price with the discount itemised separately. */

import { assert } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { formatCurrency } from "#shared/currency.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import { quoteTicketHtml } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { says } from "#test-utils/says.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** Set up a listing at £10.00 with a 10%-off promo code modifier ("SAVE10").
 * Returns the listing so tests can build their /calculate POST body. */
const setupPromoListing = async () => {
  await setupStripe();
  const listing = await createTestListing({
    maxQuantity: 5,
    name: "Workshop",
    unitPrice: 1000,
  });
  await modifiersTable.insert({
    calcKind: "percent",
    calcValue: 10,
    codeIndex: await hmacHash(normalizeCode("SAVE10")),
    direction: "discount",
    name: "10% off",
    trigger: "code",
  });
  return listing;
};

/** Quote one ticket on the promo listing, optionally sending a promo code,
 * and return the summary HTML. */
const quotePromoListing = async (
  extra: Record<string, string> = {},
): Promise<string> => {
  const listing = await setupPromoListing();
  return quoteTicketHtml(listing.slug, {
    [`quantity_${listing.id}`]: "1",
    ...extra,
  });
};

describeWithEnv("server (/calculate promo-code quotes)", { db: true }, () => {
  test("applies a promo code discount when the correct code is submitted", async () => {
    const html = await quotePromoListing({ promo_code: "SAVE10" });

    // Discount line shown with modifier name and negative amount.
    says(html, "10% off");
    says(html, formatCurrency(-100));
    // Total reflects the discounted price (10% off £10.00 = £9.00).
    says(html, formatCurrency(900));
    says(html, "order-summary-total");
  });

  test("shows the listing price before modifiers, not the discounted line price", async () => {
    const html = await quotePromoListing({ promo_code: "SAVE10" });

    // The ticket line is the full £10.00 list price, so the discount isn't
    // baked into it — the modifier is itemised separately on its own row...
    says(html, formatCurrency(1000));
    says(html, "10% off");
    says(html, formatCurrency(-100));
    // ...and only the total carries the £9.00 discounted figure.
    says(html, formatCurrency(900));
  });

  test("does not apply a promo code discount when no code is submitted", async () => {
    const html = await quotePromoListing();

    // Full price — no promo code entered, no discount line.
    says(html, formatCurrency(1000));
    assert(!html.includes(formatCurrency(900)));
    assert(!html.includes("10% off"));
  });

  test("does not apply a promo code discount when a wrong code is submitted", async () => {
    const html = await quotePromoListing({ promo_code: "WRONGCODE" });

    // Full price — wrong promo code, no discount line.
    says(html, formatCurrency(1000));
    assert(!html.includes(formatCurrency(900)));
    assert(!html.includes("10% off"));
  });

  test("applies a promo code discount case-insensitively", async () => {
    const html = await quotePromoListing({ promo_code: "save10" });

    // Lowercase variant of the code should still match.
    says(html, "10% off");
    says(html, formatCurrency(-100));
    says(html, formatCurrency(900));
  });
});
