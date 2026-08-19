/**
 * What one recovery check amounted to, as the event that moves its row.
 *
 * This module is pure: the caller reads SumUp and settles the callback, and
 * this names what the pair of answers means. It never decides where the row
 * lands — the moves table does that — so a wrong name here is a wrong reading
 * of the evidence, never a row in a state nothing can leave.
 */

import type { CallbackOutcome } from "#routes/api/payment-callback.ts";
import type { RecoveryEventId } from "#shared/payment/sumup-recovery-machine-spec.ts";
import type { SumupCheckoutStatus } from "#shared/sumup-observation.ts";

/** What the checkout read came back as. A read we could not use at all is not
 * a status: it is the absence of one, and it must never be read as "unpaid". */
export type SumupCheckoutReading = SumupCheckoutStatus | "unusable";

/** What a settled callback says about the money, for a checkout SumUp has
 * confirmed was paid. Every outcome maps to exactly one, so a new outcome
 * stops this compiling until someone decides what it means for the money. */
const PAID_EVENTS: Record<CallbackOutcome["kind"], RecoveryEventId> = {
  // Booked, so the money is accounted for by a ticket.
  booked: "read_paid_booked",
  // Someone else holds the reservation right now; ask again shortly.
  held: "read_paid_unreadable",
  // The engine says the payment is not complete, but SumUp says it is: the
  // two disagree about a checkout we created.
  not_yet: "read_paid_contradiction",
  // The reference did not open the staged row, so we can neither read the
  // booking nor prove the charge is ours to return.
  refused: "read_paid_contradiction",
  // No booking, and nothing is left owing.
  settled: "read_paid_settled",
  unpaid: "read_paid_contradiction",
  // Signed and ours, but the booking would not read; ask again.
  unreadable: "read_paid_unreadable",
  // SumUp says paid and the engine says otherwise. These three cannot happen
  // from a paid reading today, and if one ever does the two sides disagree
  // about a checkout we created, which is exactly a contradiction.
  unrecognised: "read_paid_contradiction",
  // No booking, and a return that was needed did not go through.
  unsettled: "read_paid_unsettled",
  // Paid, but the price proof in our own staged metadata did not verify. We
  // wrote that metadata, so this is SumUp's checkout disagreeing with our own
  // record of it, and the money must not be touched on a proof we cannot
  // trust. Kept for the operator rather than closed.
  unverifiable: "read_paid_contradiction",
};

/** The event a check amounted to, from what SumUp said and what settling it
 * produced. The callback outcome is only consulted for a checkout SumUp
 * confirmed as paid: for every other reading, SumUp's own answer is the more
 * trustworthy of the two and settles the matter on its own. */
export const sumupRecoveryOutcome = (
  reading: SumupCheckoutReading,
  outcome: CallbackOutcome,
): RecoveryEventId => {
  switch (reading) {
    case "unusable":
      return "read_unavailable";
    case "PENDING":
      return "read_pending";
    case "EXPIRED":
    case "FAILED":
      return "read_expired_or_failed";
    case "PAID":
      return PAID_EVENTS[outcome.kind];
  }
};
