/**
 * Builders for the checkout `intent` object that the Stripe and Square payment
 * tests send into `createCheckoutSession` / `createPaymentLink`. Every intent
 * carries the same always-empty fields (address, date, special instructions),
 * so a test should spell out only the buyer and the items it actually cares
 * about and let these fill in the rest.
 */

import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";

/** One checkout line — the common single-ticket line, with any field changed. */
export const checkoutItem = (
  changes: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId: 1,
  name: "Test",
  quantity: 1,
  slug: "test-listing",
  unitPrice: 1000,
  ...changes,
});

/** A ready-to-send checkout intent. Defaults to one buyer ("John") with a
 *  single default line; pass `changes` to set the email, name, phone, items,
 *  reservation amount, etc. that a given test needs. */
export const checkoutIntent = (
  changes: Partial<CheckoutIntent> = {},
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "john@example.com",
  items: [checkoutItem()],
  name: "John",
  phone: "",
  special_instructions: "",
  ...changes,
});

/** A batch of numbered lines ("Listing 1", "Listing 2", …) — used by the tests
 *  that push the serialized metadata past a provider's size limit. */
export const numberedItems = (count: number): CheckoutItem[] =>
  Array.from({ length: count }, (_, i) =>
    checkoutItem({
      listingId: i + 1,
      name: `Listing ${i + 1}`,
      slug: `listing-${i + 1}`,
    }),
  );
