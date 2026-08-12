/* jscpd:ignore-start -- imports */
import { type Money, money, sameMoney } from "#shared/payment/money.ts";
import type {
  ProviderRead,
  ProviderUnavailableReason,
} from "#shared/payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#shared/payment/refund-attempt.ts";

/* jscpd:ignore-end */

type UnavailableReason = Exclude<
  ProviderUnavailableReason,
  "network_error" | "not_configured"
>;

type UncertainRefund = Extract<RefundAttemptResult, { kind: "uncertain" }>;
type FailedRefund = Extract<
  RefundAttemptResult,
  { kind: "rejected" | "uncertain" }
>;
type ConnectionReason = Extract<
  ProviderUnavailableReason,
  "network_error" | "timeout"
>;

/** Transport facts a provider adapter can prove about one caught error. */
export type ProviderFailureFacts = {
  connectionReason?: ConnectionReason | undefined;
  malformed?: boolean | undefined;
  statusCode?: number | undefined;
};

/** The read and refund meanings of the same known provider failure. */
export type ProviderFailure = {
  read: ProviderRead<never>;
  refund: FailedRefund;
};

const httpUnavailableReason = (statusCode: number): UnavailableReason =>
  statusCode === 429
    ? "rate_limited"
    : statusCode === 408 || statusCode === 504
      ? "timeout"
      : "provider_error";

const httpReadFailure = (statusCode: number): ProviderRead<never> =>
  statusCode === 404
    ? { status: "missing" }
    : statusCode === 400 || statusCode === 422
      ? { reason: "rejected_request", status: "invalid" }
      : { reason: httpUnavailableReason(statusCode), status: "unavailable" };

const httpRefundFailure = (statusCode: number): FailedRefund =>
  statusCode >= 400 &&
  statusCode < 500 &&
  statusCode !== 408 &&
  statusCode !== 409 &&
  statusCode !== 429
    ? { kind: "rejected", reason: "rejected" }
    : uncertainRefund(httpUnavailableReason(statusCode));

/** Refuse a provider answer that does not match its documented shape. */
export const malformedProviderRead = (): ProviderRead<never> => ({
  reason: "malformed_response",
  status: "invalid",
});

/** Give one known transport failure its read and refund meanings. */
export const providerFailure = ({
  connectionReason,
  malformed,
  statusCode,
}: ProviderFailureFacts): ProviderFailure | undefined => {
  if (statusCode !== undefined) {
    return {
      read: httpReadFailure(statusCode),
      refund: httpRefundFailure(statusCode),
    };
  }
  if (connectionReason !== undefined) {
    return {
      read: { reason: connectionReason, status: "unavailable" },
      refund: uncertainRefund(connectionReason),
    };
  }
  if (malformed) {
    return {
      read: malformedProviderRead(),
      refund: uncertainRefund("malformed_response"),
    };
  }
  return;
};

/** Use refund money only after its parent and amount exactly match admission. */
export const withExactRefundMoney = <Result>(
  request: RefundRequest,
  parentId: string,
  amount: unknown,
  currency: unknown,
  useMoney: (money: Money) => Result,
): Result | UncertainRefund => {
  if (parentId !== request.paymentReference) {
    return uncertainRefund("mismatched_parent");
  }
  const refunded = money(amount, currency);
  if (!refunded) return uncertainRefund("malformed_money");
  if (!sameMoney(refunded, request.charge.captured)) {
    return uncertainRefund("mismatched_money");
  }
  return useMoney(refunded);
};
