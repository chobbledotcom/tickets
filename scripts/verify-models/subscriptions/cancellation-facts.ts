/** Observed rows keep a scenario and attempt so equal payments do not merge. */
import type { FactsOf } from "./controls.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const CANCELLATION_TABLES = {
  checkouts: [
    "Checkouts",
    {
      after: "Str",
      attempt: "Int",
      attendeeId: "Int",
      authorityLocal: "Str",
      authorityReturned: "Int",
      authorityRows: "Int",
      bookingId: "Int",
      cancels: "Int",
      chargeNamed: "Bool",
      confirmed: "Bool",
      disposition: "Str",
      durableRefunded: "Bool",
      endOrder: "Int",
      entrypoint: "Str",
      failureStored: "Bool",
      held: "Int",
      heldAtCancel: "Int",
      invoiceIdentityKept: "Bool",
      invoiceReads: "Int",
      invoiceRequestId: "Str",
      listingId: "Int",
      observed: "Str",
      owned: "Bool",
      paymentLegs: "Int",
      paymentReference: "Str",
      planAtCancel: "Int",
      planKept: "Bool",
      planRows: "Int",
      quantity: "Int",
      readIdentityKept: "Bool",
      readRequestId: "Str",
      reads: "Int",
      refundBeforeEnd: "Int",
      refundCash: "Int",
      refunded: "Bool",
      refundLegs: "Int",
      refundOrder: "Int",
      refunds: "Int",
      requestId: "Str",
      scenario: "Str",
      sessionId: "Str",
      signedOrder: "Bool",
      start: "Str",
      subscriptionId: "Str",
      threw: "Bool",
    },
  ],
  owners: [
    "Owners",
    {
      after: "Str",
      attempt: "Int",
      attendeeId: "Int",
      before: "Str",
      bookingId: "Int",
      cancels: "Int",
      cash: "Int",
      firstCash: "Int",
      firstGroup: "Str",
      firstInvoice: "Str",
      firstLegs: "Int",
      identityCurrent: "Bool",
      invoiceIdentityKept: "Bool",
      invoiceReads: "Int",
      invoiceRequestId: "Str",
      invoicesRead: "Bool",
      legs: "Int",
      listingId: "Int",
      observed: "Str",
      planKept: "Bool",
      quantity: "Int",
      readIdentityKept: "Bool",
      readRequestId: "Str",
      reads: "Int",
      requestId: "Str",
      returned: "Bool",
      scenario: "Str",
      secondCash: "Int",
      secondGroup: "Str",
      secondInvoice: "Str",
      secondLegs: "Int",
      subscriptionId: "Str",
      threw: "Bool",
    },
  ],
  writes: [
    "Writes",
    {
      affected: "Int",
      after: "Str",
      attempt: "Int",
      before: "Str",
      scenario: "Str",
      snapshot: "Str",
      target: "Str",
    },
  ],
} as const;
/* jscpd:ignore-end */

export type CancellationFacts = FactsOf<typeof CANCELLATION_TABLES>;

/** These controls change a database write or provider request before readback. */
export type CancellationFault =
  | "none"
  | "local-end-without-money"
  | "stale-overwrite"
  | "wrong-cancellation-identity"
  | "wrong-owner-subscription-read"
  | "wrong-owner-invoice-read"
  | "wrong-checkout-subscription-read"
  | "anchorless-plan-loss"
  | "refund-before-confirmed-end"
  | "duplicate-refund"
  | "false-local-completion";
