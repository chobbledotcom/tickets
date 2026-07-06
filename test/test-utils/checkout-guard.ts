import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";

/** Stub the Stripe checkout-session creator so any call would be observable,
 * run `submit` to POST a form, and confirm the request redirected (302)
 * WITHOUT ever creating a checkout session. Used by the guards that must turn a
 * booking away before payment (missing CSRF, purchase-only tier, …). */
export const expectNoCheckoutSession = async (
  submit: () => Promise<Response>,
): Promise<void> => {
  const mockCreate = stub(stripePaymentProvider, "createCheckoutSession", () =>
    Promise.resolve({
      checkoutUrl: "https://checkout.stripe.com/should-not-run",
      sessionId: "cs_should_not_run",
    }),
  );
  try {
    const response = await submit();
    expect(response.status).toBe(302);
    expect(mockCreate.calls.length).toBe(0);
  } finally {
    mockCreate.restore();
  }
};
