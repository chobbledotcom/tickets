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

const completedPaymentForOrder = (
  payment: SquarePayment,
  paymentId: string,
  order: SquareOrder,
): CompletedSquarePayment | null => {
  const amount = payment.amountMoney?.amount;
  const currency = payment.amountMoney?.currency;
  const refunded = payment.refundedMoney;
  const refundedAmount = refunded?.amount;
  if (
    payment.id !== paymentId ||
    payment.orderId !== order.id ||
    typeof amount !== "bigint" ||
    !currency ||
    currency !== order.totalMoney.currency ||
    amount !== order.totalMoney.amount ||
    amount < BigInt(0) ||
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    (refunded !== undefined &&
      (typeof refundedAmount !== "bigint" ||
        refundedAmount < BigInt(0) ||
        refundedAmount > amount ||
        refunded.currency !== currency))
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
    refundedAmount: refunded === undefined ? 0 : Number(refunded.amount),
  };
};

export type FindCompletedPaymentResult =
  | { status: "found"; payment: CompletedSquarePayment }
  | { status: "no_completed_payment" }
  | { status: "invalid_payment" };

export const findCompletedSquarePayment =
  (
    retrievePayment: (paymentId: string) => Promise<SquarePayment | null>,
  ): ((order: SquareOrder) => Promise<FindCompletedPaymentResult>) =>
  async (order: SquareOrder): Promise<FindCompletedPaymentResult> => {
    let foundInvalid = false;
    for (const paymentId of squareTenderPaymentIds(order)) {
      const payment = await retrievePayment(paymentId);
      if (payment?.status !== "COMPLETED") continue;
      const completed = completedPaymentForOrder(payment, paymentId, order);
      if (completed) return { payment: completed, status: "found" };
      foundInvalid = true;
    }
    return foundInvalid
      ? { status: "invalid_payment" }
      : { status: "no_completed_payment" };
  };
