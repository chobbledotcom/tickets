import { assert } from "@std/assert";
import type {
  CreateAttendeeResult,
  ListingBooking,
} from "#db/attendee-types.ts";
import { createAttendeeAtomicImpl as createAttendeeAtomic } from "#db/attendees/create.ts";

/** The contact a refused cart names. A caller that books two carts in one case
 *  gives each its own contact, so the two never share an email. */
export type RefusedBookingContact = { email: string; name: string };

const DEFAULT_CONTACT: RefusedBookingContact = {
  email: "refused@example.com",
  name: "Refused",
};

/**
 * Book one cart line through the write-side guard and assert it refuses.
 *
 * `createAttendeeAtomic` runs no read-time preflight, so this pins the atomic
 * guard alone. The refused result comes back so a caller can name the reason.
 */
export const expectWriteRefused = async (
  line: ListingBooking,
  contact: RefusedBookingContact = DEFAULT_CONTACT,
): Promise<Extract<CreateAttendeeResult, { success: false }>> => {
  const result = await createAttendeeAtomic({
    bookings: [line],
    email: contact.email,
    name: contact.name,
  });
  assert(!result.success, "The write admitted a cart it must refuse");
  return result;
};
