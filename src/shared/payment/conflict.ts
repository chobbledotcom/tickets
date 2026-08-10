/**
 * What can be wrong with a payment, as a list of named problems.
 *
 * Its own file because both the answer a reading produces and the check on a
 * stored answer need these names, and neither should have to load the other to
 * get them. Every kind here is one a reading of a payment can actually
 * produce; a problem nothing can report would be a name with no meaning.
 */

import * as v from "valibot";
import { kindObject } from "#shared/validation/kind.ts";

export const PaymentConflictSchema = v.variant("kind", [
  kindObject("resource_mismatch"),
  kindObject("currency_mismatch"),
  kindObject("provider_total_mismatch"),
  kindObject("partial_charge"),
  kindObject("capture_total_mismatch"),
  kindObject("refund_exceeds_capture"),
  kindObject("duplicate_charge"),
  kindObject("multiple_charges"),
  kindObject("paid_without_charge"),
  kindObject("partial_refund"),
  kindObject("failed_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;
