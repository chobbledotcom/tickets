/**
 * Shared test helper for the "what order did we try to charge?" check.
 *
 * Dozens of payment and parent-booking tests replace Stripe's "make me a
 * checkout page" step with a stub that remembers the order the app handed it
 * (the "checkout intent"), so the test can read back the exact items, prices,
 * and day count without talking to a real provider. The stub body was
 * hand-copied at every one of those sites; it lives here once instead.
 */

import { stub } from "@std/testing/mock";
import type { CheckoutIntent } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";

/**
 * Stand in for Stripe's checkout-session creation and remember the order the
 * app asked to charge. Read the captured order back through `.intent` after
 * driving the booking, and call `.restore()` (in a `finally`) to put the real
 * provider back.
 */
export const captureCheckoutIntent = (
  sessionId: string,
): { readonly intent: CheckoutIntent | undefined; restore: () => void } => {
  let captured: CheckoutIntent | undefined;
  const mock = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    (intent: CheckoutIntent) => {
      captured = intent;
      return Promise.resolve({
        checkoutUrl: "https://stripe.test/checkout",
        sessionId,
      });
    },
  );
  return {
    get intent() {
      return captured;
    },
    restore: () => mock.restore(),
  };
};
