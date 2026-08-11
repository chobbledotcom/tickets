/**
 * What can be wrong with a payment, as a list of named problems. Its own file
 * because both the answer a reading produces and the check on a stored answer
 * need these names, and neither should have to load the other.
 *
 * Every kind here is one a reading can actually produce. Judging money against
 * what was owed needs a whole reading of the checkout, which nothing builds
 * yet, so only the problems a charge's own money can show are named.
 */

import * as v from "valibot";
import { kindObject } from "#shared/validation/kind.ts";

export const PaymentConflictSchema = v.variant("kind", [
  kindObject("multiple_pending_refunds"),
  kindObject("refund_exceeds_capture"),
  kindObject("partial_refund"),
]);
export type PaymentConflict = v.InferOutput<typeof PaymentConflictSchema>;
