import { unique } from "#fp";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { Money } from "#shared/payment-state/resources.ts";

interface SquareResourceFields {
  createdAt?: string | undefined;
  id?: string | undefined;
  locationId?: string | undefined;
}

export interface SquareOrder extends SquareResourceFields {
  metadata?: Record<string, string> | undefined;
  state?: string | undefined;
  tenders?:
    | Array<{
        id?: string | undefined;
        paymentId?: string | undefined;
      }>
    | undefined;
  totalMoney: { amount: bigint; currency: string };
}

type SquareMoney = {
  amount?: bigint | undefined;
  currency?: string | undefined;
};

export interface SquarePayment extends SquareResourceFields {
  amountMoney?: SquareMoney | undefined;
  orderId?: string | undefined;
  refundedMoney?: SquareMoney | undefined;
  status?: string | undefined;
}

export type CompletedSquarePayment = {
  amountTotal: number;
  paymentReference: string;
  refundedAmount: number;
};

export type SquarePaymentMoney = { captured: Money; refunded: Money };

export const squarePaymentMoneyOrNull = (
  payment: SquarePayment,
): SquarePaymentMoney | null => {
  const amount = payment.amountMoney?.amount;
  const currency = payment.amountMoney?.currency;
  const refunded = payment.refundedMoney;
  const refundedAmount = refunded === undefined ? BigInt(0) : refunded.amount;
  if (
    typeof amount !== "bigint" ||
    amount <= BigInt(0) ||
    amount > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof currency !== "string" ||
    currency === "" ||
    typeof refundedAmount !== "bigint" ||
    refundedAmount < BigInt(0) ||
    refundedAmount > amount ||
    (refunded !== undefined && refunded.currency !== currency)
  ) {
    return null;
  }
  return {
    captured: { amount: Number(amount), currency },
    refunded: { amount: Number(refundedAmount), currency },
  };
};

export const squareTenderPaymentIds = (order: SquareOrder): string[] =>
  unique(
    (order.tenders === undefined ? [] : order.tenders)
      .toReversed()
      .flatMap((tender) => (tender.paymentId ? [tender.paymentId] : [])),
  );

const completedPaymentForOrder = (
  payment: SquarePayment,
  paymentId: string,
  order: SquareOrder,
): CompletedSquarePayment | null => {
  const money = squarePaymentMoneyOrNull(payment);
  if (
    payment.id !== paymentId ||
    payment.orderId !== order.id ||
    money === null ||
    money.captured.currency !== order.totalMoney.currency
  ) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Square payment ${paymentId} is not a valid completed payment for order ${order.id}`,
    });
    return null;
  }
  return {
    amountTotal: money.captured.amount,
    paymentReference: paymentId,
    refundedAmount: money.refunded.amount,
  };
};

export type CompletedPaymentSearch =
  | { status: "found"; payments: CompletedSquarePayment[] }
  | { status: "no_completed_payment" }
  | { status: "invalid_payment" };

type CheckedCompletedPayment =
  | { status: "not_completed" }
  | { status: "invalid" }
  | { status: "valid"; payment: CompletedSquarePayment };

type SquarePaymentResult = readonly [string, SquarePayment | null];

export const resolveCompletedSquarePayments = (
  order: SquareOrder,
  results: readonly SquarePaymentResult[],
): CompletedPaymentSearch => {
  const checked = results.map(
    ([paymentId, payment]): CheckedCompletedPayment => {
      if (payment?.status !== "COMPLETED") {
        return { status: "not_completed" };
      }
      const completed = completedPaymentForOrder(payment, paymentId, order);
      return completed === null
        ? { status: "invalid" }
        : { payment: completed, status: "valid" };
    },
  );
  if (checked.some((payment) => payment.status === "invalid")) {
    return { status: "invalid_payment" };
  }
  const payments = checked.flatMap((payment) =>
    payment.status === "valid" ? [payment.payment] : [],
  );
  return payments.length === 0
    ? { status: "no_completed_payment" }
    : { payments, status: "found" };
};

export const findCompletedSquarePayments =
  (
    retrievePayment: (paymentId: string) => Promise<SquarePayment | null>,
  ): ((
    order: SquareOrder,
    paymentIds?: string[],
  ) => Promise<CompletedPaymentSearch>) =>
  async (
    order: SquareOrder,
    paymentIds = squareTenderPaymentIds(order),
  ): Promise<CompletedPaymentSearch> => {
    const results = await Promise.all(
      paymentIds.map(
        async (paymentId) =>
          [paymentId, await retrievePayment(paymentId)] as const,
      ),
    );
    return resolveCompletedSquarePayments(order, results);
  };
