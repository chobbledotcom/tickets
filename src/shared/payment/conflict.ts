/**
 * What can be wrong with a payment, as a list of named problems. This lives in
 * its own file. Both the answer a reading produces and the check on a stored
 * answer need these names, and neither must load the other.
 *
 * Every kind here is one a reading can actually produce. Judging money against
 * what was owed needs a whole reading of the checkout, which nothing builds
 * yet. Only the problems a charge's own money can show are named.
 */

export type PaymentConflict = {
  readonly kind:
    | "multiple_pending_refunds"
    | "partial_refund"
    | "refund_exceeds_capture";
};
