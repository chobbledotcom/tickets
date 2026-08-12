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

/** Evidence that is allowed to retire each kind of payment review. */
export const PAYMENT_REVIEW_RETIREMENT = {
  multiple_pending_refunds: "clean_provider_evidence",
  partial_refund: "all_returned_and_recorded",
  partially_returned_obligation: "all_returned_and_recorded",
  refund_exceeds_capture: "clean_provider_evidence",
  shared_reference: "unique_reference",
  uncertain_keyless_refund: "all_returned_and_recorded",
} as const satisfies Record<
  PaymentReviewReason["kind"],
  "all_returned_and_recorded" | "clean_provider_evidence" | "unique_reference"
>;

/** One exact disagreement, kept after acknowledgement until evidence retires
 * it. A later disagreement receives a new id, so an old form cannot act on it. */
export const PaymentReviewCaseSchema = v.strictObject({
  acknowledgedAt: v.optional(v.pipe(v.string(), v.minLength(1))),
  caseId: v.pipe(v.string(), v.minLength(1)),
  reason: PaymentReviewReasonSchema,
});
export type PaymentReviewCase = v.InferOutput<typeof PaymentReviewCaseSchema>;

/** Open a new review case only when fresh evidence introduces one. */
export const openPaymentReview = (
  reason: PaymentReviewReason,
): PaymentReviewCase => ({ caseId: crypto.randomUUID(), reason });

/** Record that the owner saw this exact case without resolving its reason. */
export const acknowledgePaymentReview = (
  review: PaymentReviewCase,
  acknowledgedAt: string,
): PaymentReviewCase => ({ ...review, acknowledgedAt });
