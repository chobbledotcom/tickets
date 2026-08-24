import * as v from "valibot";
import type {
  ProviderInvalidReason,
  ProviderRead,
} from "#payment/provider-read.ts";
import {
  judgeThrough,
  parsedBy,
  type Rung,
  refuseUnless,
  refuseUnlessAll,
} from "#payment/provider-resource-read.ts";
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

type WireTransaction = v.InferOutput<typeof TransactionSchema>;

const eventsOf = (
  transaction: WireTransaction,
): NonNullable<WireTransaction["transaction_events"]> =>
  transaction.transaction_events ?? [];

type WireEvent = NonNullable<WireTransaction["transaction_events"]>[number];

const refundEventsOf = (
  transaction: WireTransaction,
): NonNullable<WireTransaction["transaction_events"]> =>
  eventsOf(transaction).filter((event) => event.event_type === "REFUND");

/** Refuse a transaction that carries any event we cannot account for. */
const refuseAnyEvent = (
  reason: ProviderInvalidReason,
  isUnusable: (event: WireEvent) => boolean,
): Rung<WireTransaction> =>
  refuseUnless(
    reason,
    (transaction) => !eventsOf(transaction).some(isUnusable),
  );

/** What SumUp must state about a transaction before we can read its money,
 *  in the order the facts bind: shape, identity, account, then lifecycle. */
const TRANSACTION_RUNGS = (
  facts: TransactionFacts,
): readonly Rung<WireTransaction>[] => [
  refuseUnlessAll("missing_documented_resource", [
    (transaction) => transaction.id !== undefined,
    (transaction) => transaction.merchant_code !== undefined,
    (transaction) => transaction.status !== undefined,
  ]),
  refuseUnless(
    "mismatched_id",
    (transaction) => transaction.id === facts.transactionId,
  ),
  refuseUnless(
    "mismatched_account",
    (transaction) => transaction.merchant_code === facts.merchantCode,
  ),
  refuseUnless(
    "unsupported_status",
    (transaction) =>
      transaction.status !== undefined && isCapturedStatus(transaction.status),
  ),
  refuseAnyEvent(
    "missing_documented_resource",
    (event) => event.event_type === undefined,
  ),
  refuseAnyEvent(
    "unsupported_status",
    (event) => event.event_type === "CHARGE_BACK",
  ),
  // A refunded transaction that names no refund has lost the only account
  // SumUp keeps of the money that went back.
  refuseUnless(
    "missing_documented_resource",
    (transaction) =>
      transaction.status !== "REFUNDED" ||
      refundEventsOf(transaction).length > 0,
  ),
];

/** Validate one transaction against the id and account we asked SumUp for. */
export const readSumupTransaction = (
  body: unknown,
  facts: TransactionFacts,
): ProviderRead<SumupTransactionMoney> =>
  judgeThrough({
    accept: (transaction: WireTransaction): SumupTransactionMoney => ({
      amount: transaction.amount,
      currency: transaction.currency,
      refundEvents: refundEventsOf(transaction).map((event) => ({
        amount: event.amount,
        status: event.status,
      })),
    }),
    parse: parsedBy(TransactionSchema),
    rungs: TRANSACTION_RUNGS(facts),
  })(body);
