/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type {
  PaymentCharge,
  PaymentSession,
} from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { makeProviderCheckout } from "#shared/payment-helpers.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  invalidProviderNotice,
  providerNotice,
} from "#shared/payment-runtime/provider-notice.ts";
import {
  foundProviderPayment,
  invalidProviderRead,
  missingProviderRead,
  providerCharge,
  providerFactDetails,
} from "#shared/payment-runtime/provider-read.ts";
import {
  completedProviderRefund,
  failedProviderRefund,
  partialProviderRefund,
  pendingProviderRefund,
} from "#shared/payment-runtime/provider-refund.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import {
  type ChargeLeg,
  type ProviderResource,
  type RefundObservation,
  type RefundResolution,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import type {
  PaymentProvider,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import { sameMoney } from "#shared/provider-boundary.ts";
import {
  invalidProviderReadResult,
  providerReadForTransportIssue,
  providerReadValidator,
} from "#shared/provider-transport.ts";
import {
  type SumupCheckout,
  type SumupReadResult,
  type SumupTransaction,
  sumupApi,
} from "#shared/sumup.ts";

/* jscpd:ignore-end */

const SumupWebhookSchema = v.object({
  event_type: ResourceIdSchema,
  id: ResourceIdSchema,
});

const sumupResources = PAYMENT_PROVIDER_RESOURCES.sumup;

const createSumupCheckout = makeProviderCheckout(
  "SumUp",
  (checkout) => sumupApi.createCheckout(checkout),
  (result, checkout) => ({
    session: result === null ? undefined : sumupResources.session(result.id),
    sessionId: checkout.localPaymentId,
    url: result?.url,
  }),
);

const checkoutStatus = (
  status: SumupCheckout["status"],
): "failed" | "paid" | "pending" => {
  if (status === "PAID") return "paid";
  return status === "PENDING" ? "pending" : "failed";
};

const transactionStatus = (
  status: SumupTransaction["status"],
): "failed" | "paid" | "pending" => {
  if (status === "SUCCESSFUL" || status === "REFUNDED") return "paid";
  return status === "PENDING" ? "pending" : "failed";
};

const paymentForCheckout = async (
  payment: PaymentSession | null,
  checkout: SumupCheckout,
): Promise<PaymentSession | null> => {
  if (payment !== null) return payment;
  const [stored] = await getPaymentSessions([checkout.reference]);
  return stored ?? null;
};

type StoredCheckoutIssue =
  | "malformed_response"
  | "mismatched_account"
  | "mismatched_id"
  | "mismatched_parent";

const storedCheckoutIssue = async (
  checkout: SumupCheckout,
  stored: PaymentSession,
): Promise<StoredCheckoutIssue | null> => {
  if (checkout.reference !== stored.id) return "mismatched_id";
  if (
    stored.session !== null &&
    (stored.session.provider !== "sumup" || stored.session.id !== checkout.id)
  ) {
    return "mismatched_parent";
  }
  const account = await resolvePaymentAccount("sumup");
  if (
    checkout.merchantCode !== settings.sumup.merchantCode ||
    stored.accountId !== account.accountId ||
    stored.mode !== account.mode
  ) {
    return "mismatched_account";
  }
  return sameMoney(stored.expected, {
    amount: checkout.amountMinor,
    currency: checkout.currency,
  })
    ? null
    : "malformed_response";
};

const refundObservation = (
  refund: SumupTransaction["refunds"][number],
): RefundObservation | null => {
  if (refund.status === "completed") return null;
  return refund.status === "pending"
    ? { amount: refund.amount, status: "pending" }
    : {
        amount: refund.amount,
        reason: "provider_failed",
        status: "failed",
      };
};

const chargeFromTransaction = (
  transaction: SumupTransaction,
  checkoutId: string,
): ChargeLeg => ({
  ...providerCharge(
    transaction.amount,
    transaction.refunded,
    sumupResources.charge(transaction.id, checkoutId),
  ),
  refunds: transaction.refunds.flatMap((refund) => {
    const observation = refundObservation(refund);
    return observation === null ? [] : [observation];
  }),
});

type SumupTransactionRead =
  | { charges: ChargeLeg[]; status: "failed" | "paid" | "pending" }
  | { read: ProviderRead };

const readSumupTransaction = async (
  checkout: SumupCheckout,
  payment: PaymentSession,
  requested: ProviderResource,
): Promise<SumupTransactionRead> => {
  const transactionId = checkout.transactionId;
  if (transactionId === undefined) {
    return { charges: [], status: checkoutStatus(checkout.status) };
  }
  if (
    requested.kind === "sumup_transaction" &&
    requested.id !== transactionId
  ) {
    return invalidProviderReadResult(requested, payment, "mismatched_id");
  }
  const result = await sumupApi.getTransactionStatus(transactionId);
  if (result.status !== "found") {
    return {
      read: providerReadForTransportIssue(result, payment, requested),
    };
  }
  const transaction = result.value;
  const malformed = providerReadValidator(requested, payment)(
    sameMoney(transaction.amount, {
      amount: checkout.amountMinor,
      currency: checkout.currency,
    }) &&
      transaction.merchantCode === checkout.merchantCode &&
      Date.parse(transaction.timestamp) >= Date.parse(checkout.createdAt),
    "malformed_response",
  );
  if (malformed !== null) return malformed;
  const status = transactionStatus(transaction.status);
  return {
    charges:
      status === "paid"
        ? [chargeFromTransaction(transaction, checkout.id)]
        : [],
    status,
  };
};

const readSumupPayment: PaymentProvider["readPayment"] = async (
  payment,
  requested,
) => {
  if (
    requested.kind !== "sumup_checkout" &&
    requested.kind !== "sumup_transaction"
  ) {
    return invalidProviderRead(requested, payment, "mismatched_parent");
  }
  const checkoutId =
    requested.kind === "sumup_checkout" ? requested.id : requested.parentId;
  const result = await sumupApi.retrieveCheckoutById(checkoutId);
  if (result.status !== "found") {
    return providerReadForTransportIssue(result, payment, requested);
  }
  const checkout = result.value;
  const stored = await paymentForCheckout(payment, checkout);
  if (stored === null) return missingProviderRead(null, requested);
  const issue = await storedCheckoutIssue(checkout, stored);
  if (issue !== null) return invalidProviderRead(requested, stored, issue);
  const transaction = await readSumupTransaction(checkout, stored, requested);
  if ("read" in transaction) return transaction.read;
  if (
    requested.kind === "sumup_transaction" &&
    transaction.charges.length === 0
  ) {
    return invalidProviderRead(requested, stored, "unsupported_status");
  }
  return foundProviderPayment(
    stored,
    requested,
    sumupResources.session(checkout.id),
    { amount: checkout.amountMinor, currency: checkout.currency },
    transaction.status,
    providerFactDetails(transaction.charges, checkout.createdAt),
  );
};

const sumupRefundFromTransaction = (
  charge: PaymentCharge,
  result: SumupReadResult<SumupTransaction>,
): RefundResolution => {
  if (result.status === "unavailable") {
    return pendingProviderRefund(charge, null);
  }
  if (result.status === "missing") return failedProviderRefund(charge);
  const transaction = result.value;
  if (
    !sameMoney(transaction.amount, charge.captured) ||
    transaction.merchantCode !== settings.sumup.merchantCode ||
    (transaction.status !== "SUCCESSFUL" && transaction.status !== "REFUNDED")
  ) {
    return failedProviderRefund(charge);
  }
  if (transaction.refunded.amount >= charge.captured.amount) {
    return completedProviderRefund(charge, null);
  }
  if (transaction.refunded.amount > charge.refunded.amount) {
    return partialProviderRefund(transaction.refunded, null);
  }
  if (transaction.refunds.some((refund) => refund.status === "failed")) {
    return failedProviderRefund(charge);
  }
  return pendingProviderRefund(charge, null);
};

const requestNewSumupRefund: PaymentProvider["refundCharge"] = async (
  charge,
  _idempotencyKey,
) => {
  const request = await sumupApi.refundTransaction(charge.providerReference.id);
  if (request.status === "missing" || request.status === "rejected") {
    return failedProviderRefund(charge);
  }
  return sumupRefundFromTransaction(
    charge,
    await sumupApi.getTransactionStatus(charge.providerReference.id),
  );
};

const observePendingSumupRefund = async (
  charge: PaymentCharge,
): Promise<RefundResolution> =>
  sumupRefundFromTransaction(
    charge,
    await sumupApi.getTransactionStatus(charge.providerReference.id),
  );

const refundSumupCharge: PaymentProvider["refundCharge"] = (
  charge,
  idempotencyKey,
) =>
  charge.refundState === "pending" ||
  charge.pendingRefundIdempotencyKey !== null
    ? observePendingSumupRefund(charge)
    : requestNewSumupRefund(charge, idempotencyKey);

const verifySumupNotice = (payload: string): Promise<WebhookVerifyResult> => {
  try {
    const parsed = v.safeParse(SumupWebhookSchema, JSON.parse(payload));
    if (!parsed.success) {
      return Promise.resolve(invalidProviderNotice("Invalid webhook payload"));
    }
    return Promise.resolve(
      providerNotice(
        parsed.output.id,
        sumupResources.session(parsed.output.id),
        parsed.output.event_type,
      ),
    );
  } catch {
    return Promise.resolve(invalidProviderNotice("Invalid JSON payload"));
  }
};

export const sumupPaymentProvider: PaymentProvider = {
  createCheckout: createSumupCheckout,
  readPayment: readSumupPayment,
  refundCharge: refundSumupCharge,
  requiresWebhookSignature: false,
  setupWebhookEndpoint: (): Promise<WebhookSetupResult> =>
    Promise.resolve({
      error:
        "SumUp webhooks are configured automatically per checkout — no setup needed",
      success: false,
    }),
  type: "sumup",
  verifyWebhookSignature: verifySumupNotice,
};
