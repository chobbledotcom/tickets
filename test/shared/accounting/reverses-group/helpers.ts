/** Seeding for the reverses-group backfill, shared by its direct tests and
 *  the refund-order-link migration's. */

import { bookingEventGroup, refundEventGroup } from "#accounting/mappers.ts";
import { getDb } from "#db/client.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";

/** Seed a refunded booking order through the production mappers, then wipe the
 *  refund legs' link — the exact rows a site carries before the backfill. */
export const seedUnattributedRefund = async (
  eventId: string,
  listingId: number,
): Promise<string> => {
  await postAttendeeRefund({
    attendeeId: 1,
    eventId,
    gross: 500,
    listingId,
  });
  await getDb().execute({
    args: [],
    sql: "UPDATE transfers SET reverses_group = '' WHERE kind GLOB 'refund_*'",
  });
  return await bookingEventGroup(eventId);
};

/** The `reverses_group` every refund leg of one refund event carries. */
export const stampedReversesOf = async (
  group: string,
): Promise<Set<string>> => {
  const rows = await getDb().execute({
    args: [group],
    sql: "SELECT reverses_group FROM transfers WHERE event_group = ? AND kind GLOB 'refund_*'",
  });
  return new Set(rows.rows.map((row) => String(row.reverses_group)));
};

/** The refund event group a booking order's reversals land under, so a test
 *  can ask for the order's stamp without rebuilding it by hand. */
export const refundGroupOfBooking = (bookingGroup: string): Promise<string> =>
  refundEventGroup(bookingGroup);
