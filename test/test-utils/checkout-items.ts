/** The pure checkout record builders, kept apart from `checkout.ts`: that
 *  module also drives ticket pages (through `csrf.ts`), and the misplaced-test
 *  report treats any helper chain reaching the routes as integration. A test
 *  building records here loads no app graph. */
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";

/** A checkout line item with sensible defaults; override any field. */
export const checkoutItem = (
  overrides: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

/** A checkout intent with sensible defaults; override any field. */
export const checkoutIntent = (
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [checkoutItem()],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...overrides,
});
