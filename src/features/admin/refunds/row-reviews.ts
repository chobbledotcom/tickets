/** Local payment-row review changes made while a refund fence is held. */

import type { PaymentReviewReason } from "#payment/review.ts";
import type { PaymentReviewChange } from "#payment/row-transitions.ts";
import type { HeldRefundWork, RunFindings } from "./claim.ts";

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

/** Apply this run's exact decisions to the row reviews it started with. */
export const currentPaymentReviews = (
  heldReviews: HeldRefundWork["reviews"],
  findings: RunFindings,
): ReadonlyMap<string, PaymentReviewReason> =>
  [...findings.reviews].reduce(applyReviewChange, new Map(heldReviews));
