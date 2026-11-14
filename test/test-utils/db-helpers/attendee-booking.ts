import type { ListingBooking } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";

/** Book one attendee onto `bookings` and return its id, with the email derived
 *  from the name. Callers book onto listings with room, so a failed create is a
 *  broken test rather than a case to handle. */
export const bookTestAttendeeId = async (
  bookings: ListingBooking[],
  name: string,
  email = `${name.toLowerCase()}@test.com`,
): Promise<number> => {
  const made = await attendeesApi.createAttendeeAtomic({
    bookings,
    email,
    name,
  });
  if (!made.success) throw new Error("booking setup failed");
  return made.attendees[0]!.id;
};
