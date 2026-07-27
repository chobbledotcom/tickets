/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { unique } from "#fp";
import { settings } from "#shared/db/settings.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
} from "#shared/payment-helpers.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  foundProviderPayment,
  invalidProviderRead,
  invalidProviderReadFor,
  missingProviderRead,
  providerCharge,
  providerFactDetails,
  unavailableProviderRead,
} from "#shared/payment-runtime/provider-read.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { type SquareResourceRead, squareApi } from "#shared/square.ts";
import {
  SquareOrderStatusSchema,
  SquarePaymentStatusSchema,
} from "#shared/square-client.ts";
import { readSquarePaymentPages } from "#shared/square-payment-pages.ts";
import {
  type CompletedSquarePayment,
  resolveCompletedSquarePayments,
  type SquareOrder,
  type SquarePayment,
  squareTenderPaymentIds,
} from "#shared/square-payments.ts";

/* jscpd:ignore-end */

const squareResources = PAYMENT_PROVIDER_RESOURCES.square;

type ProviderRead = Awaited<ReturnType<PaymentProvider["readPayment"]>>;
type StoredPayment = Parameters<PaymentProvider["readPayment"]>[0];
type RequestedPayment = Parameters<PaymentProvider["readPayment"]>[1];
type SquarePaymentIssue = Parameters<typeof invalidProviderRead>[2];
type SquarePaymentRead = readonly [string, SquareResourceRead<SquarePayment>];

type SquareReadContext = {
  locationId: string;
  orderId: string;
  payment: StoredPayment;
  requested: RequestedPayment;
};

type CheckedSquarePayment = {
  amount: { amount: bigint; currency: string };
  createdAt: string;
  issue: null;
  orderId: string;
  status: v.InferOutput<typeof SquarePaymentStatusSchema>;
};

type ExactSquarePayment = { id: string; payment: SquarePayment };

const invalidSquareRead = (
  context: SquareReadContext,
  reason: SquarePaymentIssue,
): { read: ProviderRead } => ({
  read: invalidProviderReadFor(context, reason),
});

const unresolvedSquareRead = <Value>(
  read: Exclude<SquareResourceRead<Value>, { status: "found" }>,
  payment: StoredPayment,
  requested: RequestedPayment,
): ProviderRead => {
  if (read.status === "missing") return missingProviderRead(payment, requested);
  return read.status === "unavailable"
    ? unavailableProviderRead(payment, requested)
    : invalidProviderRead(requested, payment, read.reason);
};

const validSquareMoney = (
  money:
    | {
        amount?: bigint | undefined;
        currency?: string | undefined;
      }
    | undefined,
): money is { amount: bigint; currency: string } =>
  money !== undefined &&
  typeof money.amount === "bigint" &&
  money.amount >= 0n &&
  money.amount <= BigInt(Number.MAX_SAFE_INTEGER) &&
  /^[A-Z]{3}$/u.test(money.currency ?? "");

const checkSquarePayment = (
  payment: SquarePayment,
  id: string,
  orderId: string,
  locationId: string,
  currency?: string,
): { issue: SquarePaymentIssue } | CheckedSquarePayment => {
  const amount = payment.amountMoney;
  const refunded = payment.refundedMoney;
  const createdAt = toCanonicalIso(payment.createdAt);
  if (payment.id !== id) return { issue: "mismatched_id" };
  if (payment.orderId !== orderId) return { issue: "mismatched_parent" };
  if (payment.locationId !== locationId) return { issue: "mismatched_account" };
  if (
    createdAt === undefined ||
    !v.is(SquarePaymentStatusSchema, payment.status) ||
    !validSquareMoney(amount) ||
    (currency !== undefined && amount.currency !== currency) ||
    (refunded !== undefined &&
      (!validSquareMoney(refunded) ||
        refunded.currency !== amount.currency ||
        refunded.amount > amount.amount))
  ) {
    return { issue: "malformed_response" };
  }
  return { amount, createdAt, issue: null, orderId, status: payment.status };
};

const squareOrderIssue = (
  order: SquareOrder,
  id: string,
  locationId: string,
): SquarePaymentIssue | null => {
  if (order.id !== id) return "mismatched_id";
  if (order.locationId !== locationId) return "mismatched_account";
  return toCanonicalIso(order.createdAt) === undefined ||
    !v.is(SquareOrderStatusSchema, order.state) ||
    !validSquareMoney(order.totalMoney)
    ? "malformed_response"
    : null;
};

const squareStatus = (status: SquarePayment["status"]): "failed" | "pending" =>
  status === "CANCELED" || status === "FAILED" ? "failed" : "pending";

const squareCharge = (
  orderId: string,
  payment: CompletedSquarePayment,
  currency: string,
): ReturnType<typeof providerCharge> =>
  providerCharge(
    { amount: payment.amountTotal, currency },
    { amount: payment.refundedAmount, currency },
    squareResources.charge(payment.paymentReference, orderId),
  );

const squareAccountMatches = async (
  payment: StoredPayment,
): Promise<boolean> => {
  if (payment === null) return true;
  const account = await resolvePaymentAccount("square");
  return (
    account.accountId === payment.accountId && account.mode === payment.mode
  );
};

const nonCompletedSquarePayment = (
  context: SquareReadContext,
  checked: CheckedSquarePayment,
): ReturnType<typeof foundProviderPayment> =>
  foundProviderPayment(
    context.payment,
    context.requested,
    squareResources.session(checked.orderId),
    {
      amount: Number(checked.amount.amount),
      currency: checked.amount.currency,
    },
    squareStatus(checked.status),
    providerFactDetails(undefined, checked.createdAt),
  );

const readExactSquarePayment = async (
  context: SquareReadContext,
): Promise<{ exact: ExactSquarePayment | null } | { read: ProviderRead }> => {
  if (context.requested.kind !== "square_payment") return { exact: null };
  const id = context.requested.id;
  const exactRead = await squareApi.readPayment(id);
  if (exactRead.status !== "found") {
    return {
      read: unresolvedSquareRead(exactRead, context.payment, context.requested),
    };
  }
  const checked = checkSquarePayment(
    exactRead.value,
    id,
    context.orderId,
    context.locationId,
  );
  if (checked.issue !== null) {
    return invalidSquareRead(context, checked.issue);
  }
  return checked.status === "COMPLETED"
    ? { exact: { id, payment: exactRead.value } }
    : { read: await nonCompletedSquarePayment(context, checked) };
};

const checkDocumentedSquarePayment = (
  context: SquareReadContext,
  order: SquareOrder,
  id: string,
  read: SquareResourceRead<SquarePayment>,
): { payment: readonly [string, SquarePayment] } | { read: ProviderRead } => {
  if (read.status !== "found") {
    return {
      read:
        read.status === "unavailable"
          ? unavailableProviderRead(context.payment, context.requested)
          : invalidProviderRead(
              context.requested,
              context.payment,
              read.status === "missing"
                ? "missing_documented_resource"
                : read.reason,
            ),
    };
  }
  const checked = checkSquarePayment(
    read.value,
    id,
    context.orderId,
    context.locationId,
    order.totalMoney.currency,
  );
  return checked.issue === null
    ? { payment: [id, read.value] }
    : invalidSquareRead(context, checked.issue);
};

const readDocumentedSquarePayments = async (
  context: SquareReadContext,
  order: SquareOrder,
  exact: ExactSquarePayment | null,
): Promise<
  { payments: Array<readonly [string, SquarePayment]> } | { read: ProviderRead }
> => {
  const paymentIds = unique([
    ...(exact === null ? [] : [exact.id]),
    ...squareTenderPaymentIds(order),
  ]);
  const listed = await readSquarePaymentPages(
    context.locationId,
    new Set(paymentIds.filter((id) => id !== exact?.id)),
    (input) => squareApi.readPayments(input),
  );
  if ("issue" in listed) {
    return listed.issue === "unavailable"
      ? { read: unavailableProviderRead(context.payment, context.requested) }
      : invalidSquareRead(context, "malformed_response");
  }
  const reads: SquarePaymentRead[] = paymentIds
    .filter((id) => id !== exact?.id)
    .map((id): SquarePaymentRead => {
      const payment = listed.payments.get(id);
      return [
        id,
        payment === undefined
          ? { status: "missing" }
          : { status: "found", value: payment },
      ];
    });
  if (exact !== null) {
    reads.unshift([exact.id, { status: "found", value: exact.payment }]);
  }
  const payments: Array<readonly [string, SquarePayment]> = [];
  for (const [id, read] of reads) {
    const checked = checkDocumentedSquarePayment(context, order, id, read);
    if ("read" in checked) return checked;
    payments.push(checked.payment);
  }
  return { payments };
};

const resolveSquareOrder = (
  context: SquareReadContext,
  order: SquareOrder,
  payments: Array<readonly [string, SquarePayment]>,
): Promise<ProviderRead> => {
  const completed = resolveCompletedSquarePayments(order, payments);
  if (completed.status === "invalid_payment") {
    return Promise.resolve(
      invalidProviderRead(
        context.requested,
        context.payment,
        "malformed_response",
      ),
    );
  }
  if (
    completed.status === "no_completed_payment" &&
    order.state === "COMPLETED"
  ) {
    return Promise.resolve(
      invalidProviderRead(
        context.requested,
        context.payment,
        "missing_documented_resource",
      ),
    );
  }
  const currency = order.totalMoney.currency;
  const charges =
    completed.status === "found"
      ? completed.payments.map((charge) =>
          squareCharge(context.orderId, charge, currency),
        )
      : undefined;
  const metadata = hasRequiredSessionMetadata(order.metadata)
    ? order.metadata
    : undefined;
  return foundProviderPayment(
    context.payment,
    context.requested,
    squareResources.session(context.orderId),
    { amount: Number(order.totalMoney.amount), currency },
    completed.status === "found"
      ? "paid"
      : order.state === "CANCELED"
        ? "failed"
        : "pending",
    providerFactDetails(charges, toCanonicalIso(order.createdAt), metadata),
  );
};

const readSquareOrder = async (
  context: SquareReadContext,
  exact: ExactSquarePayment | null,
): Promise<ProviderRead> => {
  const orderRead = await squareApi.readOrder(context.orderId);
  if (orderRead.status !== "found") {
    return unresolvedSquareRead(orderRead, context.payment, context.requested);
  }
  const issue = squareOrderIssue(
    orderRead.value,
    context.orderId,
    context.locationId,
  );
  if (issue !== null) {
    return invalidProviderReadFor(context, issue);
  }
  const documented = await readDocumentedSquarePayments(
    context,
    orderRead.value,
    exact,
  );
  return "read" in documented
    ? documented.read
    : resolveSquareOrder(context, orderRead.value, documented.payments);
};

export const readSquarePayment: PaymentProvider["readPayment"] = async (
  payment,
  requested,
) => {
  if (!(await squareAccountMatches(payment))) {
    return invalidProviderReadFor({ payment, requested }, "mismatched_account");
  }
  const context = {
    locationId: settings.square.locationId,
    orderId: "parentId" in requested ? requested.parentId : requested.id,
    payment,
    requested,
  };
  const exact = await readExactSquarePayment(context);
  return "read" in exact ? exact.read : readSquareOrder(context, exact.exact);
};
