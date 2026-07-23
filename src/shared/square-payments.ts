import { ErrorCode, logError } from "#shared/logger.ts";

export type SquareOrder = {
  id?: string | undefined;
  metadata?: Record<string, string> | undefined;
  tenders?:
    | Array<{
        id?: string | undefined;
        paymentId?: string | undefined;
      }>
    | undefined;
  state?: string | undefined;
  totalMoney: { amount: bigint; currency: string };
  createdAt?: string | undefined;
};

type SquareMoney = {
  amount?: bigint | undefined;
  currency?: string | undefined;
};

export type SquarePayment = {
  id?: string | undefined;
  status?: string | undefined;
  orderId?: string | undefined;
  amountMoney?: SquareMoney | undefined;
  refundedMoney?: SquareMoney | undefined;
};

export type CompletedSquarePayment = {
  amountTotal: number;
  paymentReference: string;
  refundedAmount: number;
};

const MAX_TENDERS_TO_CHECK = 10;

export const squareTenderPaymentIds = (order: SquareOrder): string[] =>
  (order.tenders === undefined ? [] : order.tenders)
    .slice(-MAX_TENDERS_TO_CHECK)
    .reverse()
    .flatMap((tender) => (tender.paymentId ? [tender.paymentId] : []));

/** Closing must never scan an unbounded payment-attempt history. */
export const squareCloseTenderPaymentId = (
  order: SquareOrder,
): string | null => {
  const ids = squareTenderPaymentIds(order);
  if (ids.length > 1) {
    throw new Error(`Square order ${order.id} has multiple tenders`);
  }
  return ids[0] ?? null;
};

const completedPaymentForOrder = (
  payment: SquarePayment,
  paymentId: string,
  order: SquareOrder,
): CompletedSquarePayment | null => {
  const amount = payment.amountMoney?.amount;
  const currency = payment.amountMoney?.currency;
  const refunded = payment.refundedMoney;
  const refundedAmount = refunded === undefined ? BigInt(0) : refunded.amount;
  if (
    payment.id !== paymentId ||
    payment.status !== "COMPLETED" ||
    payment.orderId !== order.id ||
    typeof amount !== "bigint" ||
    !currency ||
    currency !== order.totalMoney.currency ||
    amount < BigInt(0) ||
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof refundedAmount !== "bigint" ||
    refundedAmount < BigInt(0) ||
    refundedAmount > amount ||
    (refunded !== undefined && refunded.currency !== currency)
  ) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Square payment ${paymentId} is not a valid completed payment for order ${order.id}`,
    });
    return null;
  }
  return {
    amountTotal: Number(amount),
    paymentReference: paymentId,
    refundedAmount: Number(refundedAmount),
  };
};

export const findCompletedSquarePayment =
  (retrievePayment: (paymentId: string) => Promise<SquarePayment | null>) =>
  async (order: SquareOrder): Promise<CompletedSquarePayment | null> => {
    for (const paymentId of squareTenderPaymentIds(order)) {
      const payment = await retrievePayment(paymentId);
      if (payment?.status !== "COMPLETED") continue;
      const completed = completedPaymentForOrder(payment, paymentId, order);
      if (completed) return completed;
    }
    return null;
  };
