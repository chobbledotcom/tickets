import * as v from "valibot";
import { malformedProviderRead } from "#shared/payment/provider-failures.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import { sumupPaymentFields } from "#shared/sumup/wire.ts";

/** One SumUp transaction's charge and refund money in provider major units. */
export type SumupTransactionMoney = {
  amount: number | undefined;
  currency: string | undefined;
  refundEvents: {
    amount: number | undefined;
    status: string | undefined;
  }[];
};

const EVENT_TYPES = [
  "CHARGE_BACK",
  "PAYOUT",
  "PAYOUT_DEDUCTION",
  "REFUND",
] as const;

const TransactionSchema = v.object({
  ...sumupPaymentFields,
  transaction_events: v.optional(
    v.array(
      v.object({
        amount: v.optional(v.number()),
        event_type: v.optional(v.picklist(EVENT_TYPES)),
        status: v.optional(v.string()),
      }),
    ),
  ),
});

const CAPTURED_STATUSES = ["REFUNDED", "SUCCESSFUL"] as const;

const isCapturedStatus = (status: string): boolean =>
  CAPTURED_STATUSES.some((captured) => captured === status);

type TransactionFacts = {
  merchantCode: string;
  transactionId: string;
};

/** Validate one transaction against the id and account we asked SumUp for. */
export const readSumupTransaction = (
  body: unknown,
  { merchantCode, transactionId }: TransactionFacts,
): ProviderRead<SumupTransactionMoney> => {
  const parsed = v.safeParse(TransactionSchema, body);
  if (!parsed.success) return malformedProviderRead();
  const transaction = parsed.output;
  if (
    transaction.id === undefined ||
    transaction.merchant_code === undefined ||
    transaction.status === undefined
  ) {
    return { reason: "missing_documented_resource", status: "invalid" };
  }
  if (transaction.id !== transactionId) {
    return { reason: "mismatched_id", status: "invalid" };
  }
  if (transaction.merchant_code !== merchantCode) {
    return { reason: "mismatched_account", status: "invalid" };
  }
  if (!isCapturedStatus(transaction.status)) {
    return { reason: "unsupported_status", status: "invalid" };
  }
  const events = transaction.transaction_events ?? [];
  if (events.some((event) => event.event_type === undefined)) {
    return { reason: "missing_documented_resource", status: "invalid" };
  }
  if (events.some((event) => event.event_type === "CHARGE_BACK")) {
    return { reason: "unsupported_status", status: "invalid" };
  }
  const refundEvents = events.filter((event) => event.event_type === "REFUND");
  const returned = transaction.status === "REFUNDED"
    ? [{ amount: transaction.amount, status: "REFUNDED" }]
    : refundEvents.map((event) => ({
      amount: event.amount,
      status: event.status,
    }));
  return {
    resource: {
      amount: transaction.amount,
      currency: transaction.currency,
      refundEvents: returned,
    },
    status: "found",
  };
};
