import { expect } from "@std/expect";
import { spy } from "@std/testing/mock";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";

/** Spy on the Stripe checkout-session creator so any call would be observable,
 * run `submit` to POST a form, and confirm the request redirected (302)
 * WITHOUT ever creating a checkout session. Used by the guards that must turn a
 * booking away before payment (missing CSRF, purchase-only tier, …). A spy
 * (not a stub with a canned response) leaves nothing to run — the whole point
 * is that it never fires — so there is no unreachable resolver body. */
export const expectNoCheckoutSession = async (
  submit: () => Promise<Response>,
): Promise<void> => {
  const mockCreate = spy(stripePaymentProvider, "createCheckoutSession");
  try {
    const response = await submit();
    expect(response.status).toBe(302);
    expect(mockCreate.calls.length).toBe(0);
  } finally {
    mockCreate.restore();
  }
};
