import { attendeeHoldsUnreturnedCash } from "#shared/db/attendees/queries.ts";
import { hasPendingCheckout } from "#shared/db/checkout-stages.ts";

/** Write-action gates shared by the attendee page and its action routes. */
export type AttendeeActionState = {
  canDelete: boolean;
  holdsUnreturnedCash: boolean;
  pendingCheckout: boolean;
};

/** Load the live states that block attendee deletion. The POST route checks
 * them again immediately before deleting, so a race still fails closed. */
export const loadAttendeeActionState = async (
  attendeeId: number,
  knownPendingCheckout?: boolean,
): Promise<AttendeeActionState> => {
  const [pendingCheckout, holdsUnreturnedCash] = await Promise.all([
    knownPendingCheckout === undefined
      ? hasPendingCheckout(attendeeId)
      : Promise.resolve(knownPendingCheckout),
    attendeeHoldsUnreturnedCash(attendeeId),
  ]);
  return {
    canDelete: !pendingCheckout && !holdsUnreturnedCash,
    holdsUnreturnedCash,
    pendingCheckout,
  };
};
