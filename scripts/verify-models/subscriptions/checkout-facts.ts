/** Checkout evidence keeps request, invoice, listing and stored row identities apart. */
import type { FactsOf } from "./controls.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const CHECKOUT_TABLES = {
  admissions: [
    "AdmissionFacts",
    {
      attempt: "Int",
      checkoutAccepted: "Bool",
      orderAccepted: "Bool",
      own: "Bool",
      partPayment: "Bool",
      provider: "Str",
      scenario: "Str",
      shape: "Str",
      subscriptions: "Int",
      total: "Int",
    },
  ],
  plans: [
    "PlanFacts",
    {
      amount: "Int",
      attempt: "Int",
      attendee: "Int",
      booking: "Int",
      expectedAmount: "Int",
      expectedInterval: "Str",
      expectedStatus: "Str",
      expectedSubscription: "Str",
      expectedTax: "Int",
      identity: "Str",
      interval: "Str",
      listing: "Int",
      owned: "Bool",
      quantity: "Int",
      scenario: "Str",
      stage: "Str",
      status: "Str",
      subscription: "Str",
      tax: "Int",
    },
  ],
  requests: [
    "RequestFacts",
    {
      attempt: "Int",
      expectedAmount: "Int",
      expectedInitial: "Int",
      expectedInterval: "Str",
      expectedOneTimeLines: "Int",
      expectedOrdinaryInitial: "Int",
      expectedQuantity: "Int",
      expectedReference: "Str",
      expectedSubscribedInitial: "Int",
      expectedTrialEnd: "Int",
      firstInvoice: "Str",
      initialQuantity: "Int",
      interval: "Str",
      invoiceRead: "Str",
      listing: "Int",
      metadataListing: "Int",
      mode: "Str",
      oneTimeAmount: "Int",
      oneTimeLines: "Int",
      ordinaryInitial: "Int",
      paymentReference: "Str",
      rate: "Int",
      recurringAmount: "Int",
      recurringLines: "Int",
      recurringQuantity: "Int",
      request: "Str",
      scenario: "Str",
      session: "Str",
      status: "Str",
      subscribedInitial: "Int",
      subscription: "Str",
      subscriptionRead: "Str",
      taxMode: "Str",
      trialEnd: "Int",
    },
  ],
} as const;
/* jscpd:ignore-end */

/** Each universe lists the expected identities of one table, before any read. */
export type CheckoutFacts = FactsOf<typeof CHECKOUT_TABLES> & {
  admissionUniverse: string[];
  requestUniverse: string[];
  planUniverse: string[];
};

/** Exact non-negative nearest-integer rounding, with a half rounded up. */
export const roundedRatio = (numerator: bigint, denominator: bigint): number =>
  Number((2n * numerator + denominator) / (2n * denominator));

/** This oracle uses integer fractions, not assessTax or planOfStart. */
export const expectedVat = (amount: number, rate: number): number =>
  roundedRatio(BigInt(amount) * BigInt(rate), 10000n + BigInt(rate));
export const expectedCharge = (
  net: number,
  mode: string,
  rate: number,
): number =>
  mode === "add_to_total"
    ? net + roundedRatio(BigInt(net) * BigInt(rate), 10000n)
    : net;
