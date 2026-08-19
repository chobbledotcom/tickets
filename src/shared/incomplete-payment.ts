import type { Attendee } from "#types";

export const isIncompletePayment = (
  attendee: Pick<Attendee, "price_paid" | "refunded" | "remaining_balance">,
  hasPaidListing: boolean,
  hasPaymentReference: boolean,
): boolean =>
  hasPaidListing &&
  !attendee.refunded &&
  !hasPaymentReference &&
  Number(attendee.price_paid) > 0 &&
  attendee.remaining_balance <= 0;
