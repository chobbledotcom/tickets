import { type Stub, stub } from "@std/testing/mock";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import type { ProviderResource } from "#shared/payment-state/resources.ts";
import type {
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_ID,
  PAYMENT_INTENT,
  PAYMENT_TIME,
  SESSION_RESOURCE,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import {
  stripeCharge,
  stripeCheckoutSession,
  stripePaymentIntent,
} from "#test/test-utils/stripe/fixtures.ts";

export const storedStripePayment = (
  changes: Partial<PaymentSession> = {},
): PaymentSession => ({
  ...sessionProgress(),
  accountId: "stripe-test-account",
  bookingIntent: PAYMENT_INTENT,
  checkoutCreate: null,
  createdAt: PAYMENT_TIME,
  expected: { amount: 900, currency: "EUR" },
  id: PAYMENT_ID,
  leaseExpiresAt: null,
  mode: "live",
  provider: "stripe",
  revision: 1,
  updatedAt: PAYMENT_TIME,
  ...changes,
});

export const stripeProviderSession = (
  changes: Parameters<typeof stripeCheckoutSession>[0] = {},
): ReturnType<typeof stripeCheckoutSession> =>
  stripeCheckoutSession({
    id: SESSION_RESOURCE.id,
    payment_intent: CHARGE_RESOURCE.id,
    ...changes,
  });

export const stripeProviderIntent = (
  changes: Parameters<typeof stripePaymentIntent>[0] = {},
): ReturnType<typeof stripePaymentIntent> =>
  stripePaymentIntent({
    id: CHARGE_RESOURCE.id,
    latest_charge: stripeCharge({ payment_intent: CHARGE_RESOURCE.id }),
    ...changes,
  });

interface StripeProviderReadOptions {
  intent?: StripeExpandedPaymentIntent;
  payment?: PaymentSession | null;
  refund?: Awaited<ReturnType<typeof stripeApi.retrieveRefund>>;
  requested?: ProviderResource;
  session?: StripeCheckoutSession;
}

/** Read through the Stripe provider with its standard API resources stubbed. */
export const readStripeProvider = async (
  options: StripeProviderReadOptions = {},
): Promise<ProviderRead> => {
  const {
    intent = stripeProviderIntent(),
    payment = storedStripePayment(),
    refund,
    requested = SESSION_RESOURCE,
    session = stripeProviderSession(),
  } = options;
  using _intent = stub(stripeApi, "lookupPaymentIntent", () =>
    Promise.resolve({ status: "found" as const, value: intent }),
  );
  using _session = stub(stripeApi, "lookupCheckoutSession", () =>
    Promise.resolve({ status: "found" as const, value: session }),
  );
  using _refund =
    refund === undefined
      ? undefined
      : stub(stripeApi, "retrieveRefund", () => Promise.resolve(refund));
  return await stripePaymentProvider.readPayment(payment, requested);
};

interface PersistedStripeRefundStubs {
  create: Stub;
  retrieve: Stub;
  [name: string]: Stub;
}

/** Stub polling an existing Stripe refund and reject any accidental new POST. */
export const stubPersistedStripeRefund = (
  refund: () => StripeRefund,
): PersistedStripeRefundStubs => ({
  create: stub(stripeApi, "requestRefund", () =>
    Promise.reject(new Error("must not POST")),
  ),
  retrieve: stub(stripeApi, "retrieveRefund", () =>
    Promise.resolve({ status: "found" as const, value: refund() }),
  ),
});
