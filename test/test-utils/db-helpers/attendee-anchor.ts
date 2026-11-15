/** A booked attendee whose claimed payment anchor is already written: the
 *  state a checkout leaves behind when a payment is held for a booking. */

import { execute } from "#db/client.ts";
import {
  type ClaimedAttendeePaymentAnchor,
  prepareClaimedAttendeePaymentAnchor,
} from "#db/payment-anchor/attendee.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { taggedPaymentReference } from "#test-utils/processed-payments.ts";
import { bookAttendee, bookedAttendee } from "./attendee-payments.ts";
import { createTestListing } from "./listings.ts";

/** Book one attendee on a fresh listing, then write the anchor for `payment`.
 *  The listing has room for that booking; the cap is never the case under
 *  test. */
export const bookAnchoredAttendee = async (
  paymentId: string,
  attendee: { email: string; name: string },
): Promise<{
  attendeeId: number;
  anchor: ClaimedAttendeePaymentAnchor;
  payment: TaggedPaymentReference;
}> => {
  const listing = await createTestListing({ maxAttendees: 50 });
  const attendeeId = bookedAttendee(await bookAttendee(listing, attendee)).id;
  const payment = taggedPaymentReference(paymentId);
  const prepared = await prepareClaimedAttendeePaymentAnchor(payment);
  const anchor = await prepared.forAttendee(attendeeId);
  await execute(anchor.statement);
  return { anchor, attendeeId, payment };
};
