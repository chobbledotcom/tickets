/** Durable owner-review findings from provider money observations. */

import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { PaymentReviewReason } from "#shared/payment/review.ts";
import { referenceRowIds } from "./candidates.ts";
import type { RunFindings } from "./claim.ts";

export type ProviderReviewFinding = {
  readonly reason: PaymentReviewReason;
  readonly reference: RefundPaymentReference;
};

/** Attach each provider conflict to the exact rows that carried its charge. */
export const recordProviderReviewFindings = (
  findings: RunFindings,
  attendeeId: number,
  reviews: readonly ProviderReviewFinding[],
): boolean => {
  for (const { reason, reference } of reviews) {
    for (const sessionId of referenceRowIds(attendeeId, reference)) {
      findings.reviews.set(sessionId, { kind: "review", reason });
    }
  }
  return reviews.length > 0;
};
