/* jscpd:ignore-start */
import * as v from "valibot";
import { withExactRefundMoney } from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { judgeThrough, refuseUnless } from "#payment/provider-resource-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import { ResourceIdSchema } from "#payment/resource-id.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  namedSquareRefund,
  readSquareResource,
  squareRefundFailure,
} from "#shared/square/outcomes.ts";
/* jscpd:ignore-end */

/** Input to Square's refund transport. */
export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountMoney: { amount: bigint; currency: string };
};

type SquareMoney = {
  amount?: bigint | undefined;
  currency?: string | undefined;
};

/** The payment facts Square returns before the shared money boundary parses
 * them. Optional money fields stay optional so absence is never read as zero. */
export type SquarePayment = {
  id: string;
  status: string;
  orderId?: string | undefined;
  amountMoney?: SquareMoney | undefined;
  refundedMoney?: SquareMoney | undefined;
};

/** The two client methods payment reads and refunds need. */
export type SquarePaymentClient = {
  payments: {
    get(input: { paymentId: string }): Promise<{
      payment: SquarePayment | null;
    }>;
  };
  refunds: {
    refundPayment(input: RefundPaymentInput): Promise<unknown>;
  };
};

type GetSquarePaymentClient = () => Promise<SquarePaymentClient | null>;

const SquareTextSchema = v.pipe(v.string(), v.minLength(1));

const SquareApiMoneySchema = v.object({
  amount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  currency: SquareTextSchema,
});

const squarePaymentIdentityFields = {
  id: ResourceIdSchema,
  status: SquareTextSchema,
};

const SquareWirePaymentSchema = v.object({
  amount_money: v.optional(SquareApiMoneySchema),
  ...squarePaymentIdentityFields,
  order_id: v.optional(ResourceIdSchema),
  refunded_money: v.optional(SquareApiMoneySchema),
});

const SquarePaymentResponseSchema = v.object({
  payment: v.optional(SquareWirePaymentSchema),
});

/** Parse and normalize the REST payment response at the transport boundary. */
export const parseSquarePaymentResponse = (
  raw: unknown,
): { payment: SquarePayment | null } => {
  const { payment } = v.parse(SquarePaymentResponseSchema, raw);
  if (!payment) return { payment: null };
  return {
    payment: {
      amountMoney: payment.amount_money
        ? {
            amount: BigInt(payment.amount_money.amount),
            currency: payment.amount_money.currency,
          }
        : undefined,
      id: payment.id,
      orderId: payment.order_id,
      refundedMoney: payment.refunded_money
        ? {
            amount: BigInt(payment.refunded_money.amount),
            currency: payment.refunded_money.currency,
          }
        : undefined,
      status: payment.status,
    },
  };
};

const SquareMoneySchema = v.object({
  amount: v.optional(v.bigint()),
  currency: v.optional(v.string()),
});

const SquarePaymentSchema = v.object({
  amountMoney: v.optional(SquareMoneySchema),
  ...squarePaymentIdentityFields,
  orderId: v.optional(ResourceIdSchema),
  refundedMoney: v.optional(SquareMoneySchema),
});

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

const squareMoneyOrUndefined = (
  money:
    | {
        amount?: bigint | null | undefined;
        currency?: string | null | undefined;
      }
    | null
    | undefined,
): SquareMoney | undefined =>
  money
    ? {
        amount: money.amount ?? undefined,
        currency: money.currency ?? undefined,
      }
    : undefined;

/** Read one Square payment without collapsing absence, outages, and invalid
 * data into the same answer. */
export const readSquarePayment = (
  getClient: GetSquarePaymentClient,
  paymentId: string,
): Promise<ProviderRead<SquarePayment>> =>
  readSquareResource(getClient)(
    async (square) => (await square.payments.get({ paymentId })).payment,
    judgeThrough({
      accept: (payment: SquarePayment) => payment,
      parse: (payment: SquarePayment): SquarePayment | null => {
        const parsed = v.safeParse(SquarePaymentSchema, {
          amountMoney: squareMoneyOrUndefined(payment.amountMoney),
          id: payment.id,
          orderId: payment.orderId,
          refundedMoney: squareMoneyOrUndefined(payment.refundedMoney),
          status: payment.status,
        });
        return parsed.success ? parsed.output : null;
      },
      rungs: [
        refuseUnless("mismatched_id", (payment) => payment.id === paymentId),
        refuseUnless("unsupported_status", (payment) =>
          isSquarePaymentStatus(payment.status),
        ),
      ],
    }),
  );

const SquareRefundSchema = v.object({
  amount_money: SquareApiMoneySchema,
  id: ResourceIdSchema,
  payment_id: ResourceIdSchema,
  status: v.picklist(["PENDING", "COMPLETED", "REJECTED", "FAILED"]),
});

const SquareRefundResponseSchema = v.object({ refund: SquareRefundSchema });

const refundResultFromResponse = (
  raw: unknown,
  request: RefundRequest,
): RefundAttemptResult => {
  const parsed = v.safeParse(SquareRefundResponseSchema, raw);
  if (!parsed.success) {
    return uncertainRefund("malformed_response");
  }
  const refund = parsed.output.refund;
  return withExactRefundMoney(
    request,
    refund.payment_id,
    refund.amount_money.amount,
    refund.amount_money.currency,
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
};

/** Send the exact admitted charge and keep Square's evidence as a tagged
 * result. Unknown internal errors still propagate. */
export const refundSquareCharge = async (
  getClient: GetSquarePaymentClient,
  request: AuthorizedRefundRequest<"square">,
): Promise<RefundAttemptResult> => {
  const client = await getClient();
  if (!client) return { kind: "not_sent", reason: "not_configured" };
  let raw: unknown;
  try {
    raw = await client.refunds.refundPayment({
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
  return refundResultFromResponse(raw, request);
};
