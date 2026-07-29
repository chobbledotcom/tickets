/**
 * What can be wrong with a payment, as a list of named problems.
 *
 * Its own file because both the answer a reading produces and the check on a
 * stored answer need these names, and neither should have to load the other to
 * get them.
 */

import * as v from "valibot";
import { ProviderInvalidReasonSchema } from "#shared/payment-state/observation.ts";
import { kindObject } from "#shared/validation/kind.ts";

export const PaymentConflictSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("invalid_provider_data"),
    reason: ProviderInvalidReasonSchema,
  }),
  kindObject("missing_resource"),
  kindObject("resource_mismatch"),
  kindObject("currency_mismatch"),
  kindObject("provider_total_mismatch"),
  kindObject("partial_charge"),
  kindObject("capture_total_mismatch"),
  kindObject("refund_exceeds_capture"),
  kindObject("duplicate_charge"),
  kindObject("multiple_charges"),
  kindObject("duplicate_refund"),
  kindObject("multiple_pending_refunds"),
  kindObject("paid_without_charge"),
  kindObject("partial_refund"),
  kindObject("failed_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;

/** Whether the reading itself is the problem. Those two are all we have when
 *  a read fails, so they come with nothing to show; every other problem was
 *  spotted *in* a reading, and must bring it. Listing every kind means a new
 *  one cannot be added without saying which it is. */
export const IS_THE_READING_ITSELF: Record<PaymentConflict["kind"], boolean> = {
  capture_total_mismatch: false,
  currency_mismatch: false,
  duplicate_charge: false,
  duplicate_refund: false,
  failed_refund: false,
  invalid_provider_data: true,
  missing_resource: true,
  multiple_charges: false,
  multiple_pending_refunds: false,
  paid_without_charge: false,
  partial_charge: false,
  partial_refund: false,
  provider_total_mismatch: false,
  refund_exceeds_capture: false,
  resource_mismatch: false,
};
