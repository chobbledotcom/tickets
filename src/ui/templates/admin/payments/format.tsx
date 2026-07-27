import { t } from "#i18n";
import { getDecimalPlaces } from "#shared/currency.ts";
import type { PaymentCase } from "#shared/db/payments/types.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { Money } from "#shared/payment-state/resources.ts";

const REASON_KEYS: Readonly<Record<string, string>> = {
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

export const paymentCaseReason = (reason: string): string =>
  t(`admin.payments.reason.${REASON_KEYS[reason] ?? "other"}`);

export const paymentCaseProvider = (paymentCase: PaymentCase): string =>
  "provider" in paymentCase.resource
    ? PAYMENT_PROVIDERS[paymentCase.resource.provider].label
    : t("admin.payments.older_payment");

const RESOURCE_KEYS: Readonly<Record<string, string>> = {
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
