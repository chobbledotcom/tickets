/**
 * What can be wrong with a payment, as a list of named problems.
 *
 * Its own file because both the answer a reading produces and the check on a
 * stored answer need these names, and neither should have to load the other to
 * get them. Every kind here is one a reading of a payment can actually
 * produce; a problem nothing can report would be a name with no meaning.
 *
 * Judging money against what was owed needs a whole reading of the checkout,
 * which nothing builds yet, so the only problems named here are the ones a
 * charge's own money can show. The rest arrive with the readings that produce
 * them.
 */

import * as v from "valibot";
import { kindObject } from "#shared/validation/kind.ts";

export const PaymentConflictSchema = v.variant("kind", [
  kindObject("refund_exceeds_capture"),
  kindObject("partial_refund"),
  kindObject("failed_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;
