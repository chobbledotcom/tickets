/** Reasons a payment row must stay for an owner to inspect. */

import * as v from "valibot";
import { PaymentConflictSchema } from "#shared/payment/conflict.ts";
import { kindObject } from "#shared/validation/kind.ts";

const PaymentOperationReviewSchema = v.variant("kind", [
  kindObject("shared_reference"),
  kindObject("partially_returned_obligation"),
  kindObject("uncertain_keyless_refund"),
]);

export const PaymentReviewReasonSchema = v.union([
  PaymentConflictSchema,
  PaymentOperationReviewSchema,
]);
export type PaymentReviewReason = v.InferOutput<
  typeof PaymentReviewReasonSchema
>;

/** One exact disagreement, kept after acknowledgement until evidence retires
 * it. A later disagreement receives a new id, so an old form cannot act on it. */
export const PaymentReviewCaseSchema = v.strictObject({
  acknowledgedAt: v.optional(v.pipe(v.string(), v.minLength(1))),
  caseId: v.pipe(v.string(), v.minLength(1)),
  reason: PaymentReviewReasonSchema,
});
export type PaymentReviewCase = v.InferOutput<
  typeof PaymentReviewCaseSchema
>;

/** Open a new review case only when fresh evidence introduces one. */
export const openPaymentReview = (
  reason: PaymentReviewReason,
): PaymentReviewCase => ({ caseId: crypto.randomUUID(), reason });

/** Record that the owner saw this exact case without resolving its reason. */
export const acknowledgePaymentReview = (
  review: PaymentReviewCase,
  acknowledgedAt: string,
): PaymentReviewCase =>
  review.acknowledgedAt === undefined
    ? { ...review, acknowledgedAt }
    : review;
