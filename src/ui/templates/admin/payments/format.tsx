import { t } from "#i18n";
import { getDecimalPlaces } from "#shared/currency.ts";
import type {
  PaymentCase,
  PaymentCaseResource,
} from "#shared/db/payments/types.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { PaymentCaseReason } from "#shared/payment-state/lifecycle.ts";
import type { Money } from "#shared/payment-state/resources.ts";

// Keyed by the reason itself, so a new reason cannot be added to the payment
// vocabulary without giving it words here.
const REASON_KEYS: Readonly<Record<PaymentCaseReason, string>> = {
  capture_total_mismatch: "money_mismatch",
  currency_mismatch: "money_mismatch",
  duplicate_charge: "charge_conflict",
  duplicate_refund: "refund_conflict",
  failed_refund: "refund_failed",
  invalid_provider_data: "provider_data",
  legacy_lifecycle_unknown: "old_lifecycle",
  legacy_mapping_ambiguous: "old_mapping",
  legacy_provider_unknown: "old_provider",
  legacy_refund_amount_unknown: "old_refund",
  missing_resource: "missing",
  multiple_charges: "charge_conflict",
  multiple_pending_refunds: "refund_conflict",
  network_error: "unavailable",
  paid_without_charge: "missing_charge",
  partial_charge: "money_mismatch",
  partial_refund: "refund_partial",
  provider_total_mismatch: "money_mismatch",
  provider_unavailable: "unavailable",
  rate_limited: "unavailable",
  refund_exceeds_capture: "refund_conflict",
  resource_mismatch: "provider_data",
  timed_out: "unavailable",
};

/** A reason read back from a payment made by an older version may be a word
 *  this version no longer uses, so an unknown one is shown as "other" rather
 *  than refused. Every reason this version can write has words above. */
export const paymentCaseReason = (reason: string): string =>
  t(
    `admin.payments.reason.${REASON_KEYS[reason as PaymentCaseReason] ?? "other"}`,
  );

export const paymentCaseProvider = (paymentCase: PaymentCase): string =>
  "provider" in paymentCase.resource
    ? PAYMENT_PROVIDERS[paymentCase.resource.provider].label
    : t("admin.payments.older_payment");

// Keyed by the kind itself, so a new kind of thing a case can be about cannot
// be added without saying what to call it.
const RESOURCE_KEYS: Readonly<Record<PaymentCaseResource["kind"], string>> = {
  legacy_payment: "older_payment",
  square_order: "checkout",
  square_payment: "charge",
  square_refund: "refund",
  stripe_checkout_session: "checkout",
  stripe_payment_intent: "charge",
  stripe_refund: "refund",
  sumup_checkout: "checkout",
  sumup_refund: "refund",
  sumup_transaction: "charge",
};

export const paymentCaseResourceRole = (paymentCase: PaymentCase): string =>
  t(`admin.payments.resource.${RESOURCE_KEYS[paymentCase.resource.kind]}`);

export const paymentCaseEvidence = (paymentCase: PaymentCase): string => {
  const evidence = paymentCase.evidence;
  if (!("kind" in evidence)) {
    return "fact" in evidence
      ? t("admin.payments.evidence.legacy")
      : t("admin.payments.evidence.booking");
  }
  const read = evidence.read;
  return read.status === "found"
    ? t(`admin.payments.evidence.found.${read.observation.status}`)
    : t(`admin.payments.evidence.${read.status}`);
};

export const formatPaymentMoney = (money: Money): string => {
  const places = getDecimalPlaces(money.currency);
  return new Intl.NumberFormat("en", {
    currency: money.currency,
    style: "currency",
    trailingZeroDisplay: "stripIfInteger",
  }).format(money.amount / 10 ** places);
};
