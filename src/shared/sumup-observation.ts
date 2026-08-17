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
import {
  SumupWireTransactionSchema,
  sumupPaymentFields,
} from "#shared/sumup/wire.ts";
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

type WireTransaction = v.InferOutput<typeof SumupWireTransactionSchema>;

/** The wire fields the read uses; unknown fields are dropped, and which
 *  absences matter is decided by the rules below, not by the parse. */
const WireCheckoutSchema = v.object({
  ...sumupPaymentFields,
  checkout_reference: v.optional(v.string()),
  date: v.optional(v.string()),
  transaction_id: v.optional(v.string()),
  transactions: v.optional(v.array(SumupWireTransactionSchema)),
});
type WireCheckout = v.InferOutput<typeof WireCheckoutSchema>;

const invalidRead = (reason: ProviderInvalidReason): ProviderRead<never> => ({
  reason,
  status: "invalid",
});

/** What checking a checkout's charges concluded: a refusal reason, or an
 *  acceptance saying whether the named charge vouched for the money. Money a
 *  charge did not vouch for is carried as unreadable — the session boundary's
 *  refusal is what sends a captured charge to the refund path, while refusing
 *  the whole read would strand it once SumUp's retries run out. */
type ChildVerdict =
  | { failure: ProviderInvalidReason }
  | { failure: null; moneyVouchedFor: boolean };

/** The named charge vouches for the checkout's money only when it states
 *  both fields itself and neither disputes the checkout's own record. */
const chargeVouchesForMoney = (
  c: WireCheckout,
  charge: WireTransaction,
): boolean =>
  charge.amount !== undefined &&
  charge.currency !== undefined &&
  (c.amount === undefined || charge.amount === c.amount) &&
  (c.currency === undefined ||
    charge.currency.toUpperCase() === c.currency.toUpperCase());

const UNRECORDED_CHILD: ChildVerdict = { failure: "unrecorded_child" };

/** One lifecycle status's rule for the charges a checkout may carry. */
type ChildRule = (
  c: WireCheckout,
  charge: WireTransaction | undefined,
  extras: readonly WireTransaction[],
) => ChildVerdict;

/** A still-open checkout may carry one charge of its own — alone, and under
 *  our merchant. The checkout's own amount stays readable; a pending session
 *  is marked unpaid downstream, so nothing books from it. */
const pendingChildVerdict: ChildRule = (c, charge, extras) => {
  if (extras.length > 0) return UNRECORDED_CHILD;
  if (charge !== undefined && charge.merchant_code !== c.merchant_code) {
    return UNRECORDED_CHILD;
  }
  return { failure: null, moneyVouchedFor: true };
};

/** A paid checkout must carry exactly the successful charge its own record
 *  names, captured under our merchant. */
const paidChildVerdict: ChildRule = (c, charge, extras) => {
  if (!isResourceId(c.transaction_id ?? "") || charge === undefined) {
    return { failure: "missing_documented_resource" };
  }
  if (extras.length > 0) return UNRECORDED_CHILD;
  if (charge.id !== c.transaction_id) return UNRECORDED_CHILD;
  if (charge.merchant_code !== c.merchant_code) return UNRECORDED_CHILD;
  return { failure: null, moneyVouchedFor: chargeVouchesForMoney(c, charge) };
};

/** The one unrecorded child the boundary accepts is a charge under its own
 *  still-open checkout; a dead checkout must carry none. */
const checkChildren = (c: WireCheckout): ChildVerdict => {
  const [charge, ...extras] = (c.transactions ?? []).filter(
    (txn) => txn.status === "SUCCESSFUL",
  );
  if (c.status === "PENDING") return pendingChildVerdict(c, charge, extras);
  if (c.status === "PAID") return paidChildVerdict(c, charge, extras);
  return charge === undefined
    ? { failure: null, moneyVouchedFor: true }
    : UNRECORDED_CHILD;
};

/** Normalize the accepted wire checkout, reading its amount in the currency
 *  SumUp returned with it and carrying unreadable money through as null. */
const toSumupCheckout = (
  c: WireCheckout,
  status: SumupCheckoutStatus,
  reference: string,
  facts: SumupReadFacts,
  moneyVouchedFor: boolean,
): SumupCheckout => {
  const amount = typeof c.amount === "number" ? c.amount : null;
  const currency =
    typeof c.currency === "string" && c.currency.trim() !== ""
      ? c.currency.toUpperCase()
      : null;
  // Only a well-formed code may reach the currency helpers: Intl throws on
  // anything else, and an unusable code falls back to the site's.
  const conversionCurrency = isCurrency(currency)
    ? currency
    : facts.siteCurrency;
  // An amount finer than the currency can hold would round to something SumUp
  // never charged — as unreadable as an absent one. Money the named charge
  // did not vouch for is unreadable too: a booking must never be priced by a
  // record the captured charge itself does not confirm.
  const readable =
    moneyVouchedFor &&
    amount !== null &&
    !exceedsCurrencyPrecision(amount, conversionCurrency);
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
  const verdict = checkChildren(c);
  if (verdict.failure !== null) return invalidRead(verdict.failure);
  return {
    resource: toSumupCheckout(
      c,
      status.output,
      reference,
      facts,
      verdict.moneyVouchedFor,
    ),
    status: "found",
  };
};
