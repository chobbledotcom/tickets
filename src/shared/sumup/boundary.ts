import * as v from "valibot";
import { toMinorUnits } from "#shared/currency.ts";
import {
  CurrencySchema,
  type Money,
  MoneySchema,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import { providerInstantSchema } from "#shared/provider-boundary.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

export const SumupCheckoutStatusSchema = v.picklist([
  "PENDING",
  "FAILED",
  "PAID",
  "EXPIRED",
]);
export const SumupTransactionStatusSchema = v.picklist([
  "SUCCESSFUL",
  "CANCELLED",
  "FAILED",
  "PENDING",
  "REFUNDED",
]);

const SumupEventStatusSchema = v.picklist([
  "FAILED",
  "PAID_OUT",
  "PENDING",
  "RECONCILED",
  "REFUNDED",
  "SCHEDULED",
  "SUCCESSFUL",
]);
const SumupEventTypeSchema = v.picklist([
  "PAYOUT",
  "CHARGE_BACK",
  "REFUND",
  "PAYOUT_DEDUCTION",
]);
const SumupMajorAmountSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const SumupInstantSchema = providerInstantSchema("SumUp", (value) =>
  new Date(value).toISOString(),
);
const SumupEventIdSchema = integerAtLeast(0);

const SumupCheckoutTransactionSchema = v.object({
  id: ResourceIdSchema,
  status: SumupTransactionStatusSchema,
});

const successfulCheckoutTransactionId = (checkout: {
  transaction_id?: string | undefined;
  transactions?:
    | v.InferOutput<typeof SumupCheckoutTransactionSchema>[]
    | undefined;
}): string | undefined =>
  checkout.transaction_id ??
  checkout.transactions?.find(
    (transaction) =>
      transaction.status === "SUCCESSFUL" || transaction.status === "REFUNDED",
  )?.id;

const SumupCheckoutResponseSchema = v.pipe(
  v.object({
    amount: SumupMajorAmountSchema,
    checkout_reference: ResourceIdSchema,
    currency: CurrencySchema,
    date: SumupInstantSchema,
    id: ResourceIdSchema,
    merchant_code: ResourceIdSchema,
    status: SumupCheckoutStatusSchema,
    transaction_id: v.optional(ResourceIdSchema),
    transactions: v.optional(v.array(SumupCheckoutTransactionSchema)),
  }),
  v.check(
    (checkout) =>
      checkout.status !== "PAID" ||
      successfulCheckoutTransactionId(checkout) !== undefined,
    "A paid SumUp checkout must have a successful transaction id",
  ),
);

const sumupEventSchema = <const EventType extends v.ObjectEntries>(
  eventType: EventType,
) =>
  v.object({
    amount: v.optional(SumupMajorAmountSchema),
    ...eventType,
    id: v.optional(SumupEventIdSchema),
    status: SumupEventStatusSchema,
    timestamp: v.optional(SumupInstantSchema),
  });
const SumupDetailedEventSchema = sumupEventSchema({
  event_type: SumupEventTypeSchema,
});
const SumupCompactEventSchema = sumupEventSchema({
  type: SumupEventTypeSchema,
});
const SumupTransactionBaseSchema = v.object({
  amount: SumupMajorAmountSchema,
  currency: CurrencySchema,
  events: v.optional(v.array(SumupCompactEventSchema)),
  id: ResourceIdSchema,
  merchant_code: ResourceIdSchema,
  status: SumupTransactionStatusSchema,
  timestamp: SumupInstantSchema,
  transaction_events: v.optional(v.array(SumupDetailedEventSchema)),
});
type SumupWireTransaction = v.InferOutput<typeof SumupTransactionBaseSchema>;
type SumupWireEvent = {
  amount?: number | undefined;
  eventType: v.InferOutput<typeof SumupEventTypeSchema>;
  id?: number | undefined;
  status: v.InferOutput<typeof SumupEventStatusSchema>;
  timestamp?: string | undefined;
};

const transactionEvents = (
  transaction: SumupWireTransaction,
): SumupWireEvent[] =>
  transaction.transaction_events?.map(({ event_type, ...event }) => ({
    ...event,
    eventType: event_type,
  })) ??
  transaction.events?.map(({ type, ...event }) => ({
    ...event,
    eventType: type,
  })) ??
  [];

const refundEventsHaveAmounts = (transaction: SumupWireTransaction): boolean =>
  transactionEvents(transaction).every(
    (event) => event.eventType !== "REFUND" || event.amount !== undefined,
  );

/** The statuses SumUp uses for a refund that has actually gone through. */
const COMPLETED_REFUND_STATUSES = ["REFUNDED", "SUCCESSFUL"];
const hasCompletedRefund = (transaction: SumupWireTransaction): boolean =>
  transactionEvents(transaction).some(
    (event) =>
      event.eventType === "REFUND" &&
      COMPLETED_REFUND_STATUSES.includes(event.status),
  );

const SumupTransactionResponseSchema = v.pipe(
  SumupTransactionBaseSchema,
  v.check(
    refundEventsHaveAmounts,
    "Every SumUp refund event must have an amount",
  ),
  v.check(
    (transaction) =>
      transaction.status !== "REFUNDED" || hasCompletedRefund(transaction),
    "A refunded SumUp transaction needs refund history",
  ),
);

export interface SumupCheckout {
  amountMinor: number;
  createdAt: string;
  currency: string;
  id: string;
  merchantCode: string;
  reference: string;
  status: v.InferOutput<typeof SumupCheckoutStatusSchema>;
  transactionId?: string | undefined;
}

export type SumupRefundFact = {
  amount: Money;
  id?: number | undefined;
  status: "completed" | "failed" | "pending";
  timestamp?: string | undefined;
};

export interface SumupTransaction {
  amount: Money;
  id: string;
  merchantCode: string;
  refunded: Money;
  refunds: SumupRefundFact[];
  status: v.InferOutput<typeof SumupTransactionStatusSchema>;
  timestamp: string;
}

const money = (amount: number, currency: string): Money =>
  v.parse(MoneySchema, { amount: toMinorUnits(amount), currency });

export const parseSumupCheckout = (
  raw: unknown,
  requestedId: string,
): SumupCheckout => {
  const checkout = v.parse(
    v.pipe(
      SumupCheckoutResponseSchema,
      v.check(
        (resource) => resource.id === requestedId,
        "SumUp returned a different checkout",
      ),
    ),
    raw,
  );
  const transactionId = successfulCheckoutTransactionId(checkout);
  return {
    amountMinor: money(checkout.amount, checkout.currency).amount,
    createdAt: checkout.date,
    currency: checkout.currency,
    id: checkout.id,
    merchantCode: checkout.merchant_code,
    reference: checkout.checkout_reference,
    status: checkout.status,
    ...(transactionId === undefined ? {} : { transactionId }),
  };
};

const REFUND_STATUS = {
  FAILED: "failed",
  PENDING: "pending",
  REFUNDED: "completed",
  SUCCESSFUL: "completed",
} as const;

const toRefundFact = (
  event: SumupWireEvent,
  currency: string,
): SumupRefundFact | null => {
  if (event.eventType !== "REFUND") return null;
  if (!(event.status in REFUND_STATUS)) {
    throw new Error(`Unsupported SumUp refund status: ${event.status}`);
  }
  const amount = money(v.parse(SumupMajorAmountSchema, event.amount), currency);
  return {
    amount,
    ...(event.id === undefined ? {} : { id: event.id }),
    status: REFUND_STATUS[event.status as keyof typeof REFUND_STATUS],
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
  };
};

export const parseSumupTransaction = (
  raw: unknown,
  requestedId: string,
): SumupTransaction => {
  const transaction = v.parse(
    v.pipe(
      SumupTransactionResponseSchema,
      v.check(
        (resource) => resource.id === requestedId,
        "SumUp returned a different transaction",
      ),
    ),
    raw,
  );
  const refunds = transactionEvents(transaction).flatMap((event) => {
    const refund = toRefundFact(event, transaction.currency);
    return refund === null ? [] : [refund];
  });
  const refunded = refunds
    .filter((refund) => refund.status === "completed")
    .reduce((total, refund) => total + refund.amount.amount, 0);
  return v.parse(
    v.pipe(
      v.strictObject({
        amount: MoneySchema,
        id: ResourceIdSchema,
        merchantCode: ResourceIdSchema,
        refunded: MoneySchema,
        refunds: v.array(
          v.strictObject({
            amount: MoneySchema,
            id: v.optional(SumupEventIdSchema),
            status: v.picklist(["completed", "failed", "pending"]),
            timestamp: v.optional(SumupInstantSchema),
          }),
        ),
        status: SumupTransactionStatusSchema,
        timestamp: SumupInstantSchema,
      }),
      v.check(
        (value) => value.refunded.amount <= value.amount.amount,
        "SumUp refunded amount cannot exceed the transaction amount",
      ),
    ),
    {
      amount: money(transaction.amount, transaction.currency),
      id: transaction.id,
      merchantCode: transaction.merchant_code,
      refunded: { amount: refunded, currency: transaction.currency },
      refunds,
      status: transaction.status,
      timestamp: transaction.timestamp,
    },
  );
};

export type SumupCreateExpectation = {
  amount: Money;
  merchantCode: string;
  reference: string;
};

export type SumupCheckoutResult = {
  id: string;
  reference: string;
  url: string;
};

export const parseCreatedSumupCheckout = (
  raw: unknown,
  expected: SumupCreateExpectation,
): SumupCheckoutResult => {
  const id = v.parse(v.object({ id: ResourceIdSchema }), raw).id;
  const checkout = parseSumupCheckout(raw, id);
  v.parse(
    v.pipe(
      v.object({
        amountMinor: MoneySchema.entries.amount,
        currency: MoneySchema.entries.currency,
        merchantCode: ResourceIdSchema,
        reference: ResourceIdSchema,
      }),
      v.check(
        (value) =>
          value.amountMinor === expected.amount.amount &&
          value.currency === expected.amount.currency,
        "SumUp created checkout has unexpected money",
      ),
      v.check(
        (value) => value.reference === expected.reference,
        "SumUp created checkout has a different reference",
      ),
      v.check(
        (value) => value.merchantCode === expected.merchantCode,
        "SumUp created checkout has a different merchant",
      ),
    ),
    checkout,
  );
  const url = v.parse(
    v.object({ hosted_checkout_url: v.pipe(v.string(), v.url()) }),
    raw,
  ).hosted_checkout_url;
  return { id: checkout.id, reference: checkout.reference, url };
};
