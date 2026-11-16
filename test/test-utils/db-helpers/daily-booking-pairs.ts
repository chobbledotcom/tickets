import { queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import type { DateString } from "#shared/validation/date-string.ts";
import { setupTwoDailyBookings } from "#test/features/admin/calendar/shared.ts";
import type { ListingWithCount } from "#types";

/** Two daily listings, one booking each, with the attendee behind each booking
 *  resolved. The agent and export tests start from this pair. */
export const setupTwoDailyBookingAttendees = async (
  date?: DateString,
): Promise<{
  attendeeOn: (listingId: number) => number;
  date: DateString;
  listing1: ListingWithCount;
  listing2: ListingWithCount;
}> => {
  const { date: day, listing1, listing2 } = await setupTwoDailyBookings(date);
  const rows = await queryAll<{ attendee_id: number; listing_id: number }>(
    sql`SELECT listing_id, attendee_id FROM listing_attendees WHERE listing_id IN (${listing1.id}, ${listing2.id})`,
  );
  const attendeeOn = (listingId: number): number =>
    rows.find((row) => row.listing_id === listingId)!.attendee_id;
  return { attendeeOn, date: day, listing1, listing2 };
};
