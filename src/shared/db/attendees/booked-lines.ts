/** The booking lines of a list of attendees: which listing, and how many. */

import { mapBookingRows } from "#db/logistics.ts";
import { rowsForIds } from "#db/rows-for-ids.ts";
import { sql } from "#db/sql.ts";

/** One booking line of one attendee. A no-quantity line has quantity 0. */
export type BookedLine = {
  attendeeId: number;
  listingId: number;
  quantity: number;
};

/** Every booking line of the attendees, in one indexed read. */
export const getBookedLines = async (
  attendeeIds: readonly number[],
): Promise<BookedLine[]> =>
  mapBookingRows(
    await rowsForIds<{
      attendee_id: number;
      listing_id: number;
      quantity: number;
    }>(
      attendeeIds,
      (idSlots) =>
        sql`SELECT line.attendee_id, line.listing_id, line.quantity
           FROM listing_attendees AS line
          WHERE line.attendee_id IN (${idSlots})`,
    ),
    (row) => ({ quantity: row.quantity }),
  );
