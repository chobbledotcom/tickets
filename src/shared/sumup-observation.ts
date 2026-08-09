/**
 * Turns one fetched SumUp checkout into a typed provider read.
 *
 * This module is pure: the caller fetches and passes the raw body plus the
 * independent facts it holds (the id it asked for, the merchant this site is
 * bound to, the site currency for reading amounts). Everything here follows
 * the sandbox evidence recorded in PR3_PLAN.md: pending checkouts carry an
 * empty transactions array, paid checkouts name their transaction and carry
 * exactly one matching successful entry, failed checkouts carry only failed
 * entries.
 *
 * Ownership and money are deliberately separate refusals. A checkout whose
 * id, merchant, or named charge disagrees with our facts is refused as an
 * invalid read — nothing downstream may touch it. A checkout that proves
 * ownership but carries unreadable money is still a found read: the session
 * boundary refuses the money itself, and that refusal is what carries a
 * captured charge to the refund path instead of stranding it.
 */

import * as v from "valibot";
import { toMinorUnits } from "#shared/currency.ts";
import { isCurrency } from "#shared/payment/money.ts";
import type {
  ProviderInvalidReason,
  ProviderRead,
} from "#shared/payment/provider-read.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import { exceedsCurrencyPrecision } from "#shared/validation/money.ts";

/** SumUp's documented checkout lifecycle (pinned @sumup/sdk 0.1.6). */
const SumupCheckoutStatusSchema = v.picklist([
  "PENDING",
  "PAID",
  "FAILED",
  "EXPIRED",
]);
export type SumupCheckoutStatus = v.InferOutput<
  typeof SumupCheckoutStatusSchema
>;

/** Normalized checkout shape consumed by the provider adapter. */
export type SumupCheckout = {
  /** Our generated checkout_reference — used as the session id throughout. */
  reference: string;
  /** SumUp checkout lifecycle status. */
  status: SumupCheckoutStatus;
  /** Total amount in the app's minor units, or null when the response carried
   *  no amount, or one finer than the currency can hold — rounding that would
   *  book an amount SumUp never took. The boundary refuses a null either way. */
  amountMinor: number | null;
  /** The currency the checkout was taken in, exactly as SumUp gave it (upper-
   *  cased), or null when the response carried none. A code that is not three
   *  letters is carried through unchanged so the boundary refuses it. */
  currency: string | null;
  /** Transaction id of the completing payment (refund/payment reference). */
  transactionId: string;
  /** Checkout creation time (ISO 8601), from SumUp's `date` field. */
  createdAt?: string | undefined;
};

/** The independent facts a SumUp read is checked against. */
export type SumupReadFacts = {
  /** The merchant code this site is bound to. */
  merchantCode: string;
  /** The checkout id the read asked SumUp for. */
  requestedId: string;
  /** Currency used to read amounts when the response carries no usable code. */
  siteCurrency: string;
};

/** The wire fields a checkout and each of its transactions both carry:
 *  identity, money, merchant, and lifecycle status. */
const wireSharedFields = {
  amount: v.optional(v.number()),
  currency: v.optional(v.string()),
  id: v.optional(v.string()),
  merchant_code: v.optional(v.string()),
  status: v.optional(v.string()),
};

const WireTransactionSchema = v.object(wireSharedFields);
type WireTransaction = v.InferOutput<typeof WireTransactionSchema>;

/** The wire fields the read uses; unknown fields are dropped, and which
 *  absences matter is decided by the rules below, not by the parse. */
const WireCheckoutSchema = v.object({
  ...wireSharedFields,
  checkout_reference: v.optional(v.string()),
  date: v.optional(v.string()),
  transaction_id: v.optional(v.string()),
  transactions: v.optional(v.array(WireTransactionSchema)),
});
type WireCheckout = v.InferOutput<typeof WireCheckoutSchema>;

const invalidRead = (reason: ProviderInvalidReason): ProviderRead<never> => ({
  reason,
  status: "invalid",
});

/** Two wire money fields disagree only when both are present and differ —
 *  an absent side has nothing to disagree with, and unreadable money must
 *  reach the session boundary's refund path rather than refuse the read. */
const moneyDisagrees = (
  left: number | string | undefined,
  right: number | string | undefined,
): boolean => left !== undefined && right !== undefined && left !== right;

/** The one unrecorded child the boundary accepts is a charge under its own
 *  still-open checkout, so everything here applies to the other statuses:
 *  a paid checkout must carry exactly the successful charge its own record
 *  names, and a dead one must carry none. */
const childFailure = (c: WireCheckout): ProviderInvalidReason | null => {
  const successful = (c.transactions ?? []).filter(
    (txn) => txn.status === "SUCCESSFUL",
  );
  if (c.status === "PENDING") return null;
  if (c.status !== "PAID") {
    return successful.length > 0 ? "unrecorded_child" : null;
  }
  if (!isResourceId(c.transaction_id ?? "")) {
    return "missing_documented_resource";
  }
  const [charge, ...extras] = successful;
  if (charge === undefined) return "missing_documented_resource";
  if (extras.length > 0) return "unrecorded_child";
  return namedChargeFailure(c, charge);
};

/** Whether the paid checkout's single successful charge is the one its own
 *  record names, captured under our merchant, for the money it states. */
const namedChargeFailure = (
  c: WireCheckout,
  charge: WireTransaction,
): ProviderInvalidReason | null => {
  if (charge.id !== c.transaction_id) return "unrecorded_child";
  if (charge.merchant_code !== c.merchant_code) return "unrecorded_child";
  if (moneyDisagrees(charge.amount, c.amount)) return "unrecorded_child";
  if (
    moneyDisagrees(charge.currency?.toUpperCase(), c.currency?.toUpperCase())
  ) {
    return "unrecorded_child";
  }
  return null;
};

/** Normalize the accepted wire checkout, reading its amount in the currency
 *  SumUp returned with it and carrying unreadable money through as null. */
const toSumupCheckout = (
  c: WireCheckout,
  status: SumupCheckoutStatus,
  reference: string,
  siteCurrency: string,
): SumupCheckout => {
  const amount = typeof c.amount === "number" ? c.amount : null;
  const currency =
    typeof c.currency === "string" && c.currency.trim() !== ""
      ? c.currency.toUpperCase()
      : null;
  // Only a well-formed code may reach the currency helpers: Intl throws on
  // anything else, and an unusable code falls back to the site's.
  const conversionCurrency = isCurrency(currency) ? currency : siteCurrency;
  // An amount finer than the currency can hold would round to something SumUp
  // never charged, so it is as unreadable as an absent one.
  const readable =
    amount !== null && !exceedsCurrencyPrecision(amount, conversionCurrency);
  return {
    amountMinor: readable ? toMinorUnits(amount, conversionCurrency) : null,
    createdAt: c.date,
    currency,
    reference,
    status,
    transactionId: c.transaction_id ?? "",
  };
};

/**
 * Check one fetched checkout body against the facts we hold independently,
 * in the order the facts bind: shape, reference, id, merchant, lifecycle,
 * then the charge the record names.
 */
export const classifySumupCheckout = (
  body: unknown,
  facts: SumupReadFacts,
): ProviderRead<SumupCheckout> => {
  const parsed = v.safeParse(WireCheckoutSchema, body);
  if (!parsed.success) return invalidRead("malformed_response");
  const c = parsed.output;
  const reference = c.checkout_reference;
  // A checkout we created always carries the reference we generated; the
  // booking is encrypted under it, so without one the row cannot be opened.
  if (reference === undefined || !isResourceId(reference)) {
    return invalidRead("malformed_response");
  }
  if (c.id !== facts.requestedId) return invalidRead("mismatched_id");
  if (c.merchant_code !== facts.merchantCode) {
    return invalidRead("mismatched_account");
  }
  const status = v.safeParse(SumupCheckoutStatusSchema, c.status);
  if (!status.success) return invalidRead("unsupported_status");
  const failure = childFailure(c);
  if (failure !== null) return invalidRead(failure);
  return {
    resource: toSumupCheckout(c, status.output, reference, facts.siteCurrency),
    status: "found",
  };
};
