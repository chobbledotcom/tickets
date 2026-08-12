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
