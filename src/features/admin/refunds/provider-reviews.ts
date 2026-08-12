/** Durable owner-review findings from provider money observations. */

import type { PaymentReviewChange } from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import {
  PAYMENT_REVIEW_RETIREMENT,
  type PaymentReviewReason,
} from "#shared/payment/review.ts";
import type { HeldRefundWork, RunFindings } from "./claim.ts";

export type ProviderReviewFinding = {
  readonly reason: PaymentReviewReason;
  readonly reference: RefundPaymentReference;
};

export const resolvePaymentReview = (
  findings: RunFindings,
  sessionId: string,
  reason: PaymentReviewReason,
): void => {
  findings.reviews.set(sessionId, {
    kind: "resolved",
    reason: reason.kind,
  });
};

const findingRows = (
  reviews: readonly ProviderReviewFinding[],
): ReadonlySet<string> =>
  new Set(reviews.flatMap(({ reference }) => reference.rowSessionIds));

/** Attach each provider conflict to the exact rows that carried its charge. */
export const recordProviderReviewFindings = (
  findings: RunFindings,
  reviews: readonly ProviderReviewFinding[],
): void => {
  for (const { reason, reference } of reviews) {
    for (const sessionId of reference.rowSessionIds) {
      findings.reviews.set(sessionId, { kind: "review", reason });
    }
  }
};

const applyReviewChange = (
  current: Map<string, PaymentReviewReason>,
  [sessionId, change]: readonly [string, PaymentReviewChange],
): Map<string, PaymentReviewReason> => {
  if (change.kind === "review") {
    current.set(sessionId, change.reason);
  } else if (current.get(sessionId)?.kind === change.reason) {
    current.delete(sessionId);
  }
  return current;
};

/** Apply this run's exact decisions to the review cases it started with. */
export const currentPaymentReviews = (
  heldReviews: HeldRefundWork["reviews"],
  findings: RunFindings,
): ReadonlyMap<string, PaymentReviewReason> =>
  [...findings.reviews].reduce(applyReviewChange, new Map(heldReviews));

/** Replace current conflicts and retire only old conflicts this complete read
 * disproved. A different current issue wins over any retirement. */
export const reconcileProviderReviewFindings = (
  findings: RunFindings,
  heldReviews: HeldRefundWork["reviews"],
  references: readonly RefundPaymentReference[],
  reviews: readonly ProviderReviewFinding[],
): void => {
  const currentlyReviewed = findingRows(reviews);
  recordProviderReviewFindings(findings, reviews);
  const observedRows = new Set(
    references.flatMap(({ rowSessionIds }) => rowSessionIds),
  );
  for (const [sessionId, reason] of heldReviews) {
    if (
      observedRows.has(sessionId) &&
      !currentlyReviewed.has(sessionId) &&
      PAYMENT_REVIEW_RETIREMENT[reason.kind] === "clean_provider_evidence"
    ) {
      resolvePaymentReview(findings, sessionId, reason);
    }
  }
};
