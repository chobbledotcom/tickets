/* jscpd:ignore-start */
import { withExactRefundMoney } from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { judgedBy, refuseUnless } from "#payment/provider-resource-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  namedSquareRefund,
  readSquareResource,
  squareRefundFailure,
} from "#shared/square/outcomes.ts";
import type {
  SquareMoney,
  SquarePayment,
  SquareRefund,
} from "#shared/square/wire.ts";
/* jscpd:ignore-end */

/** Input to Square's refund transport. */
export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountMoney: SquareMoney;
};

/** The two client methods payment reads and refunds need. */
export type SquarePaymentClient = {
  payments: {
    get(input: { paymentId: string }): Promise<{
      payment: SquarePayment | null;
    }>;
  };
  refunds: {
    refundPayment(input: RefundPaymentInput): Promise<{ refund: SquareRefund }>;
  };
};

type GetSquarePaymentClient = () => Promise<SquarePaymentClient | null>;

const SQUARE_PAYMENT_STATUSES = [
  "APPROVED",
  "PENDING",
  "COMPLETED",
  "CANCELED",
  "FAILED",
] as const;
export type SquarePaymentStatus = (typeof SQUARE_PAYMENT_STATUSES)[number];

export const isSquarePaymentStatus = (
  status: string,
): status is SquarePaymentStatus =>
  SQUARE_PAYMENT_STATUSES.some((known) => known === status);

/** Read one Square payment without collapsing absence, outages, and invalid
 * data into the same answer. */
export const readSquarePayment = (
  getClient: GetSquarePaymentClient,
  paymentId: string,
): Promise<ProviderRead<SquarePayment>> =>
  readSquareResource(getClient)(
    async (square) => (await square.payments.get({ paymentId })).payment,
    judgedBy([
      refuseUnless(
        "mismatched_id",
        (payment: SquarePayment) => payment.id === paymentId,
      ),
      refuseUnless("unsupported_status", (payment: SquarePayment) =>
        isSquarePaymentStatus(payment.status),
      ),
    ]),
  );

const refundResult = (
  refund: SquareRefund,
  request: RefundRequest,
): RefundAttemptResult =>
  withExactRefundMoney(
    request,
    refund.paymentId,
    refund.amountMoney.amount,
    refund.amountMoney.currency,
    (amount): RefundAttemptResult => {
      if (refund.status === "COMPLETED" || refund.status === "PENDING") {
        return {
          amount,
          kind: refund.status === "COMPLETED" ? "completed" : "accepted",
          proof: namedSquareRefund(refund),
        };
      }
      return {
        kind: "rejected",
        reason: refund.status === "REJECTED" ? "rejected" : "failed",
      };
    },
  );

/** Send the exact admitted charge and keep Square's evidence as a tagged
 * result. Unknown internal errors still propagate. */
export const refundSquareCharge = async (
  getClient: GetSquarePaymentClient,
  request: AuthorizedRefundRequest<"square">,
): Promise<RefundAttemptResult> => {
  const client = await getClient();
  if (!client) return { kind: "not_sent", reason: "not_configured" };
  let answer: { refund: SquareRefund };
  try {
    answer = await client.refunds.refundPayment({
      amountMoney: {
        amount: BigInt(request.charge.captured.amount),
        currency: request.charge.captured.currency,
      },
      idempotencyKey: request.authorization.idempotencyKey,
      paymentId: request.paymentReference,
    });
  } catch (error) {
    const failure = squareRefundFailure(error);
    logError({
      code: ErrorCode.SQUARE_REFUND,
      detail: failure
        ? `outcome=${failure.kind} reason=${failure.reason}`
        : "outcome=thrown reason=internal_error",
      error,
    });
    if (failure) return failure;
    throw error;
  }
  return refundResult(answer.refund, request);
};
