/* jscpd:ignore-start */
import * as v from "valibot";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { MoneySchema } from "#shared/payment/money.ts";
import { createWithClient } from "#shared/payment-helpers.ts";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";
import type { SquareClient } from "#shared/square/client.ts";
import { stringEntries } from "#shared/string-entries.ts";
/* jscpd:ignore-end */

export type SquareOrder = {
  id?: string | undefined;
  locationId?: string | undefined;
  metadata?: Record<string, string> | undefined;
  tenders?:
    | Array<{ id?: string | undefined; paymentId?: string | undefined }>
    | undefined;
  state?: string | undefined;
  totalMoney: { amount: bigint | null; currency: string | null };
  createdAt?: string | undefined;
};

type SquareMoney = {
  amount?: bigint | undefined;
  currency?: string | undefined;
};

export type SquarePayment = {
  id?: string | undefined;
  locationId?: string | undefined;
  status?: string | undefined;
  orderId?: string | undefined;
  amountMoney?: SquareMoney | undefined;
  refundedMoney?: SquareMoney | undefined;
};

const SquareRefundResponseSchema = v.object({
  refund: v.object({
    amount_money: MoneySchema,
    id: v.pipe(v.string(), v.minLength(1)),
    payment_id: v.pipe(v.string(), v.minLength(1)),
    status: v.picklist(["PENDING", "COMPLETED", "REJECTED", "FAILED"]),
  }),
});

export interface SquareOperations {
  refundPayment(paymentId: string): Promise<boolean>;
  retrieveOrder(orderId: string): Promise<SquareOrder | null>;
  retrievePayment(paymentId: string): Promise<SquarePayment | null>;
}

const requireRefundMoney = (
  payment: SquarePayment | null,
  paymentId: string,
) => {
  const amount = payment?.amountMoney?.amount;
  const currency = payment?.amountMoney?.currency;
  if (!amount || !currency) {
    logError({
      code: ErrorCode.SQUARE_REFUND,
      detail: `Cannot refund payment ${paymentId}: missing amount info`,
    });
    return null;
  }
  return { amount, currency };
};

const validateRefund = (
  raw: unknown,
  paymentId: string,
  money: { amount: bigint; currency: string },
): boolean => {
  const { refund } = v.parse(SquareRefundResponseSchema, raw);
  if (refund.payment_id !== paymentId) {
    throw new Error(
      `Square refund ${refund.id} is for payment ${refund.payment_id}, not ${paymentId}`,
    );
  }
  if (
    BigInt(refund.amount_money.amount) !== money.amount ||
    refund.amount_money.currency !== money.currency
  ) {
    throw new Error(
      `Square refund ${refund.id} amount (${refund.amount_money.amount} ${refund.amount_money.currency}) does not match payment amount (${money.amount} ${money.currency})`,
    );
  }
  return refund.status === "COMPLETED";
};

export const createSquareOperations = (
  getClient: () => Promise<SquareClient | null>,
  getCurrentOperations?: () => SquareOperations,
): SquareOperations => {
  const withClient = createWithClient(getClient);
  const operations: SquareOperations = {
    refundPayment: async (paymentId) => {
      const payment = await (
        getCurrentOperations?.() ?? operations
      ).retrievePayment(paymentId);
      const money = requireRefundMoney(payment, paymentId);
      if (!money) return false;
      const client = await getClient();
      if (!client) return false;

      let raw: unknown;
      try {
        raw = await client.refunds.refundPayment({
          amountMoney: money,
          idempotencyKey: await refundIdempotencyKey("square", paymentId),
          paymentId,
        });
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        logError({
          code: ErrorCode.SQUARE_REFUND,
          detail: errorMessage(error),
        });
        return false;
      }
      return validateRefund(raw, paymentId, money);
    },
    retrieveOrder: (orderId) =>
      withClient(async (client) => {
        const { order } = await client.orders.get({ orderId });
        if (!order) return null;
        const metadata = order.metadata
          ? Object.fromEntries(stringEntries(Object.entries(order.metadata)))
          : undefined;
        return {
          createdAt: order.createdAt,
          id: order.id,
          locationId: order.locationId,
          metadata,
          state: order.state,
          tenders: order.tenders?.map((tender) => ({
            id: tender.id,
            paymentId: tender.paymentId ?? undefined,
          })),
          totalMoney: {
            amount: order.totalMoney?.amount ?? null,
            currency: order.totalMoney?.currency ?? null,
          },
        };
      }, ErrorCode.SQUARE_ORDER),

    retrievePayment: (paymentId) =>
      withClient(async (client) => {
        const { payment } = await client.payments.get({ paymentId });
        if (!payment) return null;
        return {
          amountMoney: payment.amountMoney,
          id: payment.id,
          locationId: payment.locationId,
          orderId: payment.orderId,
          refundedMoney: payment.refundedMoney,
          status: payment.status,
        };
      }, ErrorCode.SQUARE_SESSION),
  };
  return operations;
};
