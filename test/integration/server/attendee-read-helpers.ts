import { getAttendeesRaw } from "#db/attendees/queries.ts";

type RawAttendees = Awaited<ReturnType<typeof getAttendeesRaw>>;

/**
 * Fetches the raw (still-encrypted) attendee rows for two listings at once, so
 * a test can check what each listing booked. Returned as a pair to destructure.
 */
export const twoListingsAttendees = async (
  listingId1: number,
  listingId2: number,
): Promise<[RawAttendees, RawAttendees]> =>
  await Promise.all([getAttendeesRaw(listingId1), getAttendeesRaw(listingId2)]);
