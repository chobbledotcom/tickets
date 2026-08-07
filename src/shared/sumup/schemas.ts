import * as v from "valibot";
import { filter, sumOf } from "#fp";
import { CurrencySchema } from "#shared/payment/money.ts";
import { ResourceIdSchema } from "#shared/payment/resource-id.ts";
import { exceedsCurrencyPrecision } from "#shared/validation/money.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

const SumupMoneyEntries = {
  amount: v.number(),
  currency: CurrencySchema,
};

const CheckoutBaseEntries = {
  ...SumupMoneyEntries,
  checkout_reference: ResourceIdSchema,
  date: v.optional(NonEmptyTextSchema),
  id: ResourceIdSchema,
  merchant_code: NonEmptyTextSchema,
};

const SumupTransactionSchema = v.strictObject({
  ...SumupMoneyEntries,
  id: ResourceIdSchema,
  merchant_code: NonEmptyTextSchema,
  status: v.picklist(["FAILED", "SUCCESSFUL"]),
});

const PendingCheckoutSchema = v.strictObject({
  ...CheckoutBaseEntries,
  status: v.literal("PENDING"),
  transactions: v.pipe(v.array(SumupTransactionSchema), v.length(0)),
});

const PaidCheckoutSchema = v.strictObject({
  ...CheckoutBaseEntries,
  status: v.literal("PAID"),
  transaction_id: ResourceIdSchema,
  transactions: v.array(SumupTransactionSchema),
});

const FailedCheckoutSchema = v.strictObject({
  ...CheckoutBaseEntries,
  status: v.literal("FAILED"),
  transactions: v.array(SumupTransactionSchema),
});

export const SumupCheckoutResponseSchema = v.pipe(
  v.variant("status", [
    PendingCheckoutSchema,
    PaidCheckoutSchema,
    FailedCheckoutSchema,
  ]),
  v.check(
    (checkout) => !exceedsCurrencyPrecision(checkout.amount, checkout.currency),
    "Checkout amount has more precision than its currency",
  ),
);

const SumupTransactionEventSchema = v.strictObject({
  amount: v.number(),
  event_type: NonEmptyTextSchema,
  status: NonEmptyTextSchema,
});

const SumupEventSchema = v.strictObject({
  amount: v.number(),
  status: NonEmptyTextSchema,
  type: NonEmptyTextSchema,
});

export const SumupTransactionResponseSchema = v.strictObject({
  ...SumupMoneyEntries,
  events: v.array(SumupEventSchema),
  id: ResourceIdSchema,
  merchant_code: NonEmptyTextSchema,
  simple_status: NonEmptyTextSchema,
  status: NonEmptyTextSchema,
  transaction_events: v.array(SumupTransactionEventSchema),
});

type SumupTransactionResponse = v.InferOutput<
  typeof SumupTransactionResponseSchema
>;
type SumupTransactionEvent =
  SumupTransactionResponse["transaction_events"][number];

/** SumUp proves a full refund through successful refund events, not status. */
export const isSumupTransactionRefunded = (
  transaction: SumupTransactionResponse,
): boolean => {
  const refunds = filter(
    (event: SumupTransactionEvent) =>
      event.event_type === "REFUND" && event.status === "REFUNDED",
  )(transaction.transaction_events);
  return (
    refunds.length > 0 &&
    sumOf((event: SumupTransactionEvent) => event.amount)(refunds) ===
      transaction.amount
  );
};

export type SumupCheckoutResponse = v.InferOutput<
  typeof SumupCheckoutResponseSchema
>;
