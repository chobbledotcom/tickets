import type { Attendee } from "#shared/types.ts";

export const isIncompletePayment = (
  attendee: Pick<Attendee, "price_paid" | "remaining_balance">,
  hasPaidListing: boolean,
  hasPaymentReference: boolean,
): boolean =>
  hasPaidListing &&
  !hasPaymentReference &&
  Number.parseInt(attendee.price_paid, 10) > 0 &&
  attendee.remaining_balance <= 0;
