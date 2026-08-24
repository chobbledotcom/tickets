/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { type Money, money, sameMoney } from "#payment/money.ts";
import type {
  ProviderRead,
  ProviderUnavailableReason,
} from "#payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#payment/refund-attempt.ts";
import { transportFactsOf } from "#payment/transport-error.ts";

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
type ProviderFailureRead = Exclude<ProviderRead<never>, { status: "found" }>;

/** Transport facts a provider adapter can prove about one caught error. */
export type ProviderFailureFacts = {
  connectionReason?: ConnectionReason | undefined;
  malformed?: boolean | undefined;
  statusCode?: number | undefined;
};

/** The read and refund meanings of the same known provider failure. */
export type ProviderFailure = {
  read: ProviderFailureRead;
  refund: FailedRefund;
};

const httpUnavailableReason = (statusCode: number): UnavailableReason =>
  statusCode === 429
    ? "rate_limited"
    : statusCode === 408 || statusCode === 504
      ? "timeout"
      : "provider_error";

const httpReadFailure = (statusCode: number): ProviderFailureRead =>
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
export const malformedProviderRead = (): ProviderFailureRead => ({
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

/** The read and refund meanings of one caught provider error, for every
 * provider. A transport error carries its own facts. A schema failure is the
 * provider's answer not matching its documented shape, which the transport
 * cannot see because the parse happens above it. Anything else is a bug in our
 * own code, so this claims nothing and the caller re-raises it. */
export const providerFailureOf = (
  error: unknown,
): ProviderFailure | undefined => {
  const facts = transportFactsOf(error);
  if (facts !== undefined) return providerFailure(facts);
  return error instanceof v.ValiError
    ? providerFailure({ malformed: true })
    : undefined;
};

/** The known meaning of a caught provider error. An error the provider does
 * not own is a bug of ours, so it keeps travelling. */
export const requireProviderFailure = (error: unknown): ProviderFailure => {
  const failure = providerFailureOf(error);
  if (failure === undefined) throw error;
  return failure;
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
