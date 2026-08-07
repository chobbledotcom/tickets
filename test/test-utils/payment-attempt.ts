import { stub } from "@std/testing/mock";
import {
  type PaymentAttempt,
  paymentAttemptApi,
} from "#shared/payment-attempt.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** A bound payment attempt for tests that exercise provider-independent work. */
export const testPaymentAttempt = (
  overrides: Partial<PaymentAttempt> = {},
): PaymentAttempt => ({
  checkoutCompletedEventType: "checkout.completed",
  currency: "GBP",
  isPaymentRefunded: () => Promise.resolve(false),
  refundPayment: () => Promise.resolve(false),
  requiresWebhookSignature: true,
  resolveWebhookSession: () => Promise.resolve(null),
  retrieveSession: () => Promise.resolve(null),
  type: "stripe",
  verifyWebhookSignature: () =>
    Promise.resolve({ error: "Invalid signature", valid: false }),
  ...overrides,
});

/** Bind request tests to an existing stubbable provider singleton. */
export const stubProviderPaymentAttempt = (
  provider: PaymentProvider,
  overrides: Partial<PaymentAttempt> = {},
) => {
  const attempt = testPaymentAttempt({
    checkoutCompletedEventType: provider.checkoutCompletedEventType,
    isPaymentRefunded: (reference) => provider.isPaymentRefunded(reference),
    refundPayment: (reference) => provider.refundPayment(reference),
    requiresWebhookSignature: provider.requiresWebhookSignature,
    resolveWebhookSession: (listing) => provider.resolveWebhookSession(listing),
    retrieveSession: (id, paidPaymentId) =>
      provider.retrieveSession(id, paidPaymentId),
    type: provider.type,
    verifyWebhookSignature: (...args) =>
      provider.verifyWebhookSignature(...args),
    ...overrides,
  });
  return stub(paymentAttemptApi, "bind", () => Promise.resolve(attempt));
};

export const stubStripePaymentAttempt = (
  overrides: Partial<PaymentAttempt> = {},
) => stubProviderPaymentAttempt(stripePaymentProvider, overrides);

export const setupBoundStripePaymentAttempt = async (): Promise<
  ReturnType<typeof stubStripePaymentAttempt>
> => {
  await setupStripe();
  return stubStripePaymentAttempt();
};

/** Restore two stubs together, including when used with `using`. */
export const joinedStubs = <T extends { calls: unknown[]; restore(): void }>(
  primary: T,
  extra: { restore(): void },
) => {
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    primary.restore();
    extra.restore();
  };
  return {
    calls: primary.calls,
    restore,
    [Symbol.dispose]: restore,
  };
};
