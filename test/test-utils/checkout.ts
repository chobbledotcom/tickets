import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { submitTicketForm } from "./csrf.ts";
import { stubRetrieveCheckoutSession } from "./webhooks.ts";

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

/** Stub the checkout-session provider and capture the intent it was called
 * with — the shared "inspect what checkout would have charged" fixture
 * behind every test that never actually completes a paid session. The optional
 * `sessionId` labels the captured intent (defaults to `"cs_test"`). Returns
 * `checkout` (the mock, for `restore()`), `getCaptured()` (the intent handed
 * over), and `calls()` (how many times the provider was reached) so the
 * sold-out preflight case can assert it was never called. */
export const stubCheckout = (sessionId = "cs_test") => {
  let captured: CheckoutIntent | undefined;
  const checkout = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    (intent: CheckoutIntent) => {
      captured = intent;
      return Promise.resolve({
        checkoutUrl: "https://stripe.example/checkout",
        providerCheckoutId: sessionId,
        sessionId,
      });
    },
  );
  return {
    calls: () => checkout.calls.length,
    checkout,
    getCaptured: () => captured,
  };
};

/** Submit a buyer's ticket form through a stubbed checkout provider, assert
 * the redirect succeeded, and return the checkout intent it captured — the
 * shared "what would checkout have charged" flow behind every test that
 * inspects the outgoing intent rather than completing a paid session. */
export const captureCheckoutIntent = async (
  listing: { id: number; slug: string },
  fields: Record<string, string> = {},
): Promise<CheckoutIntent | undefined> => {
  const { checkout, getCaptured } = stubCheckout();
  try {
    const response = await submitTicketForm(listing.slug, {
      [`quantity_${listing.id}`]: "1",
      email: "buyer@example.com",
      name: "Buyer",
      ...fields,
    });
    expect([302, 303]).toContain(response.status);
    return getCaptured();
  } finally {
    checkout.restore();
  }
};

/** Stub the retrieved checkout session as the standard "John" buyer — the
 *  session shape the payment-flow suites share, varying only in the id, the
 *  items, and the agreed total. A paid session (the default) carries signed
 *  metadata and a payment intent; pass `paid: false` for the cancelled
 *  variant — unsigned metadata, no payment intent, and a zero total, as an
 *  abandoned checkout retrieves. */
export const johnCheckoutSession = (
  sessionId: string,
  opts:
    | { paid: false; items: string }
    | {
        paid?: true;
        items: string;
        amountTotal: number;
        paymentIntent: string;
      },
) =>
  opts.paid === false
    ? stubRetrieveCheckoutSession({
        amountTotal: 0,
        metadata: {
          email: "john@example.com",
          items: opts.items,
          name: "John",
        },
        paymentIntent: null,
        paymentStatus: "unpaid",
        sessionId,
      })
    : stubRetrieveCheckoutSession({
        amountTotal: opts.amountTotal,
        email: "john@example.com",
        items: opts.items,
        name: "John",
        paymentIntent: opts.paymentIntent,
        sessionId,
      });

/** Find the captured intent's line item for `listing` and assert its
 *  `unitPrice` — the shared "this folded line was charged X" check behind
 *  every test that inspects the outgoing intent's per-line prices. Pass the
 *  captured intent (`getCaptured()`), the listing whose price to check, and the
 *  expected unit price in the smallest currency unit (e.g. pence). */
export const expectCapturedItemPriced = (
  intent: CheckoutIntent | undefined,
  listing: { id: number },
  unitPrice: number,
): void => {
  const item = intent?.items.find((i) => i.listingId === listing.id);
  expect(item?.unitPrice).toBe(unitPrice);
};

/** Assert that an unresolved provider close blocks another checkout attempt. */
export const expectUnresolvedCancelResponse = async (
  response: Response,
): Promise<void> => {
  expect(response.status).toBe(503);
  const html = await response.text();
  expect(html).toContain(
    "We could not confirm that this payment was cancelled.",
  );
  expect(html).not.toContain("Try again");
  expect(html).not.toContain('data-payment-result="cancel"');
};
