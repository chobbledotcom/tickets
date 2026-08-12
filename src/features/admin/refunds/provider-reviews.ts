/** Durable owner-review findings from provider money observations. */

import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import type { HeldRefundWork, RunFindings } from "./claim.ts";

export type ProviderReviewFinding = {
  readonly reason: PaymentReviewReason;
  readonly reference: RefundPaymentReference;
};

const RETIRES_ON_CLEAN_PROVIDER_EVIDENCE = {
  multiple_pending_refunds: true,
  partially_returned_obligation: false,
  partial_refund: false,
  refund_exceeds_capture: true,
  shared_reference: false,
  uncertain_keyless_refund: false,
} as const satisfies Record<PaymentReviewReason["kind"], boolean>;

const findingRows = (
  reviews: readonly ProviderReviewFinding[],
): ReadonlySet<string> =>
  new Set(reviews.flatMap(({ reference }) => reference.rowSessionIds));

/** Attach each provider conflict to the exact rows that carried its charge. */
export const recordProviderReviewFindings = (
  findings: RunFindings,
  reviews: readonly ProviderReviewFinding[],
): boolean => {
  for (const { reason, reference } of reviews) {
    for (const sessionId of reference.rowSessionIds) {
      findings.reviews.set(sessionId, { kind: "review", reason });
    }
  }
  return reviews.length > 0;
};

/** Replace current conflicts and retire only old conflicts this complete read
 * disproved. A different current issue wins over any retirement. */
export const reconcileProviderReviewFindings = (
  findings: RunFindings,
  heldReviews: HeldRefundWork["reviews"],
  references: readonly RefundPaymentReference[],
  reviews: readonly ProviderReviewFinding[],
): boolean => {
  const currentlyReviewed = findingRows(reviews);
  recordProviderReviewFindings(findings, reviews);
  const observedRows = new Set(
    references.flatMap(({ rowSessionIds }) => rowSessionIds),
  );
  for (const [sessionId, reason] of heldReviews) {
    if (
      observedRows.has(sessionId) &&
      !currentlyReviewed.has(sessionId) &&
      RETIRES_ON_CLEAN_PROVIDER_EVIDENCE[reason.kind]
    ) {
      findings.reviews.set(sessionId, {
        kind: "resolved",
        reason: reason.kind,
      });
    }
  }
  return reviews.length > 0;
};
