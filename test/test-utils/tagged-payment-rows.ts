import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import type { Attendee, PaymentProviderType } from "#types";

/** Book one attendee whose processed row names its provider but carries no
 *  blind index — the state a rebuild must repair while it keeps the tag. */
export const bookTaggedWithBlankIndex = async (
  sessionId: string,
  booking: { email: string; name: string; paymentId: string },
  provider: PaymentProviderType = "square",
): Promise<Attendee> => {
  const attendee = bookedAttendee(
    await bookAttendee(await createTestListing(), booking),
  );
  await finalizeProcessedPayment(
    sessionId,
    attendee.id,
    "",
    taggedPaymentReference(booking.paymentId, provider),
  );
  await execute(
    sql`UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ${sessionId}`,
  );
  return attendee;
};
