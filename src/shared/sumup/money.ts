/* jscpd:ignore-start -- imports */
import type { EventStatus } from "@sumup/sdk";
import { compact } from "#fp";
import { toMinorUnits } from "#shared/currency.ts";
import { isCurrency, money, sameMoney } from "#shared/payment/money.ts";
import {
  mapProviderReader,
  type ProviderRead,
  type ProviderReader,
} from "#shared/payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#shared/payment/refund-attempt.ts";
import type {
  ChargeMoney,
  RefundObservation,
} from "#shared/payment/resources.ts";
import {
  chargeMoneyRead,
  refundMoneyAccountedFor,
  refundMoneyMatchesCapture,
  refundMoneyReturned,
} from "#shared/payment/resources.ts";
import type { SumupRefundSubmission } from "#shared/sumup/failures.ts";
import type { SumupTransactionMoney } from "#shared/sumup/transaction.ts";
import { sumupApi } from "#shared/sumup.ts";
import { exceedsCurrencyPrecision } from "#shared/validation/money.ts";

/* jscpd:ignore-end */

const REFUND_STATUS_MEANING = {
  FAILED: "failed",
  PAID_OUT: null,
  PENDING: "pending",
  RECONCILED: null,
  REFUNDED: "completed",
  SCHEDULED: "pending",
  SUCCESSFUL: "completed",
} as const satisfies Record<EventStatus, RefundObservation["status"] | null>;

const isKnownEventStatus = (
  status: string | undefined,
): status is keyof typeof REFUND_STATUS_MEANING =>
  status !== undefined && status in REFUND_STATUS_MEANING;

/** SumUp states money in major units and in the charge's original currency. */
const sumupMinorUnits = (
  amount: number | undefined,
  currency: string,
): number | undefined =>
  amount === undefined ||
  !Number.isFinite(amount) ||
  !isCurrency(currency.toUpperCase()) ||
  exceedsCurrencyPrecision(amount, currency)
    ? undefined
    : toMinorUnits(amount, currency);

type SumupRefundRead =
  | { resource: RefundObservation; status: "found" }
  | { reason: "malformed_money" | "unsupported_status"; status: "invalid" };

/** Read one refund event without dropping one that might have moved money. */
const readSumupRefund = (
  event: SumupTransactionMoney["refundEvents"][number],
  currency: string,
): SumupRefundRead => {
  if (!isKnownEventStatus(event.status)) {
    return { reason: "unsupported_status", status: "invalid" };
  }
  const status = REFUND_STATUS_MEANING[event.status];
  if (status === null) {
    return { reason: "unsupported_status", status: "invalid" };
  }
  const amount = money(sumupMinorUnits(event.amount, currency), currency);
  if (amount === null) {
    return { reason: "malformed_money", status: "invalid" };
  }
  return {
    resource:
      status === "failed"
        ? { amount, reason: "provider_failed", status }
        : { amount, status },
    status: "found",
  };
};

const readSumupRefunds = (
  events: SumupTransactionMoney["refundEvents"],
  currency: string,
): ProviderRead<RefundObservation[]> => {
  const reads = events.map((event) => readSumupRefund(event, currency));
  const refunds = compact(
    reads.map((read) => (read.status === "found" ? read.resource : undefined)),
  );
  const invalid = reads.find((read) => read.status === "invalid");
  return invalid ?? { resource: refunds, status: "found" };
};

/** Read one SumUp transaction as the shared charge-money shape. */
export const readSumupCharge: ProviderReader<ChargeMoney> = mapProviderReader(
  (reference) => sumupApi.readTransactionMoney(reference),
  (transaction): ProviderRead<ChargeMoney> => {
    const { currency } = transaction;
    if (currency === undefined) {
      return { reason: "malformed_money", status: "invalid" };
    }
    const refundsRead = readSumupRefunds(transaction.refundEvents, currency);
    if (refundsRead.status !== "found") return refundsRead;
    // SumUp has no cumulative total: the events are the whole account.
    return chargeMoneyRead(
      sumupMinorUnits(transaction.amount, currency),
      currency,
      0,
      refundsRead.resource,
    );
  },
);

type CheckedSubmission = Extract<
  SumupRefundSubmission,
  { kind: "sent" | "uncertain" }
>;

const noFreshRefundReason = (
  submission: CheckedSubmission,
): Extract<RefundAttemptResult, { kind: "uncertain" }>["reason"] =>
  submission.kind === "uncertain"
    ? submission.reason
    : "missing_documented_resource";

const refundCount = (
  charge: ChargeMoney,
  status: RefundObservation["status"],
): number => charge.refunds.filter((refund) => refund.status === status).length;

/** Decide a SumUp send from exactly one fresh transaction observation. */
export const sumupRefundOutcome = (
  submission: CheckedSubmission,
  request: RefundRequest,
  freshRead: ProviderRead<ChargeMoney>,
): RefundAttemptResult => {
  if (freshRead.status !== "found") {
    return uncertainRefund(
      freshRead.status === "missing"
        ? "missing_documented_resource"
        : freshRead.reason,
    );
  }
  const freshCharge = freshRead.resource;
  if (
    !sameMoney(freshCharge.captured, request.charge.captured) ||
    !refundMoneyMatchesCapture(freshCharge)
  ) {
    return uncertainRefund("mismatched_money");
  }
  const returned = refundMoneyReturned(freshCharge);
  const accountedFor = refundMoneyAccountedFor(freshCharge);
  if (
    accountedFor === 0 &&
    refundCount(freshCharge, "failed") > refundCount(request.charge, "failed")
  ) {
    return { kind: "rejected", reason: "failed" };
  }
  if (accountedFor === 0) {
    return uncertainRefund(noFreshRefundReason(submission));
  }
  if (refundCount(freshCharge, "pending") > 1) {
    return uncertainRefund("multiple_pending_refunds");
  }
  if (accountedFor !== freshCharge.captured.amount) {
    return uncertainRefund("mismatched_money");
  }
  return {
    amount: request.charge.captured,
    kind: returned === freshCharge.captured.amount ? "completed" : "accepted",
    proof: { charge: freshCharge, kind: "charge_observation" },
  };
};
