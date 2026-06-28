import { attendeeStatusesTable } from "#shared/db/attendee-statuses.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers.ts";
import { postListingSale } from "#test-utils/ledger.ts";

/** A settle identity (session id + business time) for settleAttendeeBalance. */
export const settle = (
  id = "settle-session",
): { id: string; occurredAt: string } => ({
  id,
  occurredAt: "2026-06-21T00:00:00.000Z",
});

/**
 * Create a reserved attendee owing `remainingBalance`, backed by a paid listing.
 * Outstanding balance projects from the ledger: the booking's gross sale (full
 * price = deposit + remaining) plus the £1 deposit payment, so the attendee owes
 * exactly `remainingBalance` (full − deposit) in the ledger.
 */
export const createReservedAttendee = async (
  remainingBalance: number,
  options: {
    listingName?: string;
    quantity?: number;
    /** Linked payment id stored on the attendee row (e.g. `pi_deposit`). */
    paymentId?: string;
  } = {},
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    ...(options.listingName ? { name: options.listingName } : {}),
    thankYouUrl: "https://example.com",
  });
  const reservation = await attendeeStatusesTable.insert({
    isReservation: true,
    name: "Reserved",
    reservationAmount: "10%",
  });
  const result = await createAttendeeAtomic({
    bookings: [
      {
        listingId: listing.id,
        pricePaid: 100,
        quantity: options.quantity ?? 1,
      },
    ],
    email: "guest@example.com",
    name: "Guest",
    paymentId: options.paymentId,
    remainingBalance,
    statusId: reservation.id,
  });
  if (!result.success) throw new Error("setup failed");
  const attendeeId = result.attendees[0]!.id;
  await postListingSale({
    amountPaid: 100,
    attendeeId,
    gross: 100 + remainingBalance,
    listingId: listing.id,
  });
  return { attendeeId, listingId: listing.id };
};
