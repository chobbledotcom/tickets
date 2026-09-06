import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import {
  type CheckoutIntent,
  type CheckoutSessionResult,
  paymentsApi,
} from "#shared/payments.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { awaitTestRequest, mockProviderType } from "#test-utils/mocks.ts";

export interface StripeStub {
  calls: () => number;
  getCaptured: () => CheckoutIntent | undefined;
  restore: () => void;
}

export const qrBookPath = (slug: string, token: string): string =>
  `/ticket/${slug}/qr-book?t=${encodeURIComponent(token)}`;

/** Use Stripe as the active provider and capture the checkout intent. */
export const stubStripe = (): StripeStub => {
  const providerStub = stub(paymentsApi, "getConfiguredProvider", () =>
    mockProviderType("stripe"),
  );
  const { calls, checkout, getCaptured } = stubCheckout("cs_test_123");
  return {
    calls,
    getCaptured,
    restore: () => {
      providerStub.restore();
      checkout.restore();
    },
  };
};

export const bookToken = (
  slug: string,
  payload: Parameters<typeof buildQrBookPayload>[0] = {
    name: "Ada",
    value: 1000,
  },
): Promise<string> => signQrBookToken(slug, buildQrBookPayload(payload));

export const withStripe = async (
  body: (stripe: StripeStub) => Promise<void>,
): Promise<void> => {
  const stripe = stubStripe();
  try {
    await body(stripe);
  } finally {
    stripe.restore();
  }
};

export const expectStripeRedirect = (
  response: Response,
  stripe: StripeStub,
): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain("stripe.example");
  expect(stripe.calls()).toBe(1);
};

export const expectStripeCheckoutAtPrice = (
  response: Response,
  stripe: StripeStub,
  expectedUnitPrice: number,
): void => {
  expect(response.status).toBe(302);
  // Exactly one provider checkout: a price override must not mint a second
  // session beside the one the redirect follows.
  expect(stripe.calls()).toBe(1);
  expect(stripe.getCaptured()!.items[0]!.unitPrice).toBe(expectedUnitPrice);
};

export const scanRequest = async (
  listing: { slug: string },
  payload?: Parameters<typeof bookToken>[1],
): Promise<Response> =>
  awaitTestRequest(
    qrBookPath(listing.slug, await bookToken(listing.slug, payload)),
  );

export const scanWithStripe = async (
  listing: { slug: string },
  body: (ctx: { response: Response; stripe: StripeStub }) => Promise<void>,
  payload?: Parameters<typeof bookToken>[1],
): Promise<void> => {
  const token = await bookToken(listing.slug, payload);
  await withStripe(async (stripe) => {
    const response = await awaitTestRequest(qrBookPath(listing.slug, token));
    await body({ response, stripe });
  });
};

export const scanWithCheckoutResult = async (
  listing: { slug: string },
  result: CheckoutSessionResult,
): Promise<Response> => {
  using _providerStub = stub(paymentsApi, "getConfiguredProvider", () =>
    mockProviderType("stripe"),
  );
  using _checkoutStub = stub(
    stripePaymentProvider,
    "createCheckoutSession",
    () => Promise.resolve(result),
  );
  return await scanRequest(listing);
};
