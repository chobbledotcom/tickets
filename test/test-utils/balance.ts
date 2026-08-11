import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { bookedAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

/** A settle identity (session id + business time) for settleAttendeeBalance. */
export const settle = (
  id = "settle-session",
): { id: string; occurredAt: string } => ({
  id,
  occurredAt: "2026-06-21T00:00:00.000Z",
});

/** Shared options both attendee factories accept. */
type OwingOptions = {
  listingName?: string;
  quantity?: number;
  /** Linked payment id stored on the attendee row (e.g. `pi_deposit`). */
  paymentId?: string;
};

/**
 * Book an attendee onto `listingId` in `statusId`, owing `remainingBalance`.
 * Outstanding balance projects from the ledger: the booking's gross sale (full
 * price = deposit + remaining) plus the £1 deposit payment, so the attendee owes
 * exactly `remainingBalance` (full − deposit) in the ledger.
 */
const bookAttendeeOwing = async (
  listingId: number,
  statusId: number,
  remainingBalance: number,
  options: OwingOptions,
): Promise<number> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId, pricePaid: 100, quantity: options.quantity ?? 1 }],
    email: "guest@example.com",
    name: "Guest",
    ...(options.paymentId !== undefined
      ? { paymentId: options.paymentId }
      : {}),
    remainingBalance,
    statusId,
  });
  const attendeeId = bookedAttendee(result).id;
  await postListingSale({
    amountPaid: 100,
    attendeeId,
    gross: 100 + remainingBalance,
    listingId,
  });
  return attendeeId;
};

/**
 * Build an attendee-owing-a-balance factory for a freshly-inserted status.
 * `isReservation` picks whether that status is a reservation (10% deposit) or
 * an ordinary paid status; both back the attendee with a real paid listing.
 */
const makeOwingAttendee =
  (isReservation: boolean, statusName: string, reservationAmount: string) =>
  async (
    remainingBalance: number,
    options: OwingOptions = {},
  ): Promise<{ attendeeId: number; listingId: number }> => {
    const listing = await createTestListing({
      maxAttendees: 10,
      ...(options.listingName ? { name: options.listingName } : {}),
      thankYouUrl: "https://example.com",
    });
    const status = await attendeeStatuses.table.insert({
      isReservation,
      name: statusName,
      reservationAmount,
    });
    const attendeeId = await bookAttendeeOwing(
      listing.id,
      status.id,
      remainingBalance,
      options,
    );
    return { attendeeId, listingId: listing.id };
  };

/** Create a reserved attendee owing `remainingBalance` on a paid listing. */
export const createReservedAttendee = makeOwingAttendee(
  true,
  "Reserved",
  "10%",
);

/**
 * Create a NON-reservation attendee owing `remainingBalance` on a paid listing.
 * Proves a balance is payable online whatever status the booking sits in.
 */
export const createNonReservationAttendee = makeOwingAttendee(
  false,
  "Confirmed",
  "0",
);
