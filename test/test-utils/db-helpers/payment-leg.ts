import { mapBooking } from "#accounting/mappers.ts";
import { postTransfers } from "#accounting/store.ts";

const OCCURRED_AT = "2026-07-01T00:00:00.000Z";

/** Post a payment leg for one booking line (no sale leg) — like
 *  recordPlaceholderRefund with refunded=false. Shared by test suites that
 *  set up a payment-only account for refresh/refund testing. */
export const postPaymentLeg = async (
  attendeeId: number,
  amount: number,
  eventId: string,
  listingId: number,
  gross: number,
): Promise<void> => {
  await postTransfers(
    await mapBooking({
      amountPaid: amount,
      attendeeId,
      bookingFee: 0,
      eventId,
      lines: [{ gross, listingId }],
      modifiers: [],
      occurredAt: OCCURRED_AT,
    }),
  );
};
