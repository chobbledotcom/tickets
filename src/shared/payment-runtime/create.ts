/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import {
  applyPaymentSessionClaim,
  claimPaymentCheckoutCreation,
  type PaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  createPaymentSession,
  getPaymentSessionsPrimary,
} from "#shared/db/payments/sessions.ts";
import type {
  PaymentSession,
  PaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import {
  checkoutDisplayOrder,
  type PaymentCheckoutCreateSnapshot,
  PaymentCheckoutCreateSnapshotSchema,
} from "#shared/payment-checkout.ts";
import { toBookingIntent, toCheckoutResult } from "#shared/payment-helpers.ts";
import {
  PaymentAccountConfigurationError,
  requireStoredPaymentAccount,
  resolvePaymentAccount,
} from "#shared/payment-runtime/account.ts";
import { metadataForStoredPayment } from "#shared/payment-runtime/metadata.ts";
import type { ProviderSessionResource } from "#shared/payment-state/resources.ts";
import {
  type CheckoutIntent,
  type CheckoutSessionResult,
  getActivePaymentProvider,
  getPaymentProvider,
  type PaymentProvider,
  type ProviderCheckoutResult,
} from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

const CREATION_LEASE_MS = 5 * 60 * 1_000;

/** Price and canonicalise one checkout exactly once before it is persisted. */
export const preparePaymentCheckout = async (
  provider: PaymentProviderType,
  intent: CheckoutIntent,
  baseUrl: string,
  localPaymentId: string,
): Promise<PaymentCheckoutCreateSnapshot> => {
  const order = priceCheckout(intent);
  const bookingIntent = await toBookingIntent(intent);
  const expected = {
    amount: order.total,
    currency: settings.currency.toUpperCase(),
  };
  return v.parse(PaymentCheckoutCreateSnapshotSchema, {
    baseUrl,
    bookingIntent,
    expected,
    localPaymentId,
    metadata: await metadataForStoredPayment(
      provider,
      bookingIntent,
      expected.amount,
      localPaymentId,
    ),
    order: checkoutDisplayOrder(order),
  });
};

const creationProgress = (
  state: "created" | "pending" | "failed",
  session: ProviderSessionResource | null,
  nextReconcileAt: number | null = null,
): PaymentSessionProgress => ({
  attendeeId: null,
  completion: null,
  completionState: "none" as const,
  nextReconcileAt,
  result: null,
  resultState: "none" as const,
  session,
  state,
  ticketState: "none" as const,
  ticketTokens: null,
});

const finishCreation = async (
  claim: PaymentSessionClaim,
  result: ProviderCheckoutResult,
): Promise<void> => {
  await applyPaymentSessionClaim(
    claim,
    result === null
      ? creationProgress("created", null, Date.now() + 60_000)
      : "error" in result
        ? creationProgress("failed", null)
        : creationProgress("pending", result.session, Date.now() + 60_000),
  );
};

const submitPaymentCheckout = async (
  provider: PaymentProvider,
  claim: PaymentSessionClaim,
  checkout: PaymentCheckoutCreateSnapshot,
): Promise<CheckoutSessionResult> => {
  let result: ProviderCheckoutResult;
  try {
    result = await provider.createCheckout(checkout);
  } catch (error) {
    await finishCreation(claim, null);
    throw error;
  }
  if (
    result !== null &&
    !("error" in result) &&
    result.session.provider !== provider.type
  ) {
    await finishCreation(claim, null);
    throw new Error("Provider returned the wrong payment resource");
  }
  await finishCreation(claim, result);
  if (result === null || "error" in result) return result;
  return toCheckoutResult(result.sessionId, result.checkoutUrl, "Payment");
};

const paymentAccount = (payment: PaymentSession) => ({
  accountId: payment.accountId,
  mode: payment.mode,
  provider: payment.provider,
});

/** Repeat one uncertain provider create from its durable exact input. */
export const resumePaymentCheckout = async (
  paymentId: string,
): Promise<CheckoutSessionResult> => {
  const [payment] = await getPaymentSessionsPrimary([paymentId]);
  if (payment === null || payment === undefined) {
    throw new Error(`Payment session ${paymentId} was not found`);
  }
  if (payment.state !== "created" || payment.session !== null) return null;
  if (payment.checkoutCreate === null) {
    throw new Error(
      `Payment session ${paymentId} has no checkout creation data`,
    );
  }
  const claim = await claimPaymentCheckoutCreation(
    paymentId,
    CREATION_LEASE_MS,
  );
  if (claim === null) return null;
  let provider: PaymentProvider;
  try {
    await requireStoredPaymentAccount(paymentAccount(payment));
    provider = await getPaymentProvider(payment.provider);
  } catch (error) {
    if (error instanceof PaymentAccountConfigurationError) {
      const result = { error: error.message };
      await finishCreation(claim, result);
      return result;
    }
    await finishCreation(claim, null);
    throw error;
  }
  return submitPaymentCheckout(provider, claim, payment.checkoutCreate);
};

/** Persist and submit one checkout while retaining the existing HTTP result. */
export const createPaymentCheckout = async (
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<CheckoutSessionResult> => {
  const provider = await getActivePaymentProvider();
  if (provider === null) return null;
  const account = await resolvePaymentAccount(provider.type);

  const localPaymentId = crypto.randomUUID();
  const checkout = await preparePaymentCheckout(
    account.provider,
    intent,
    baseUrl,
    localPaymentId,
  );
  await createPaymentSession({
    accountId: account.accountId,
    bookingIntent: checkout.bookingIntent,
    checkoutCreate: checkout,
    expected: checkout.expected,
    id: localPaymentId,
    mode: account.mode,
    provider: account.provider,
    session: null,
  });
  const claim = await requirePaymentSessionClaim(
    localPaymentId,
    CREATION_LEASE_MS,
  );

  return submitPaymentCheckout(provider, claim, checkout);
};
