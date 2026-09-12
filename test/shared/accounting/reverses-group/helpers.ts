/** Seeding for the reverses-group backfill, shared by its direct tests and
 *  the refund-order-link migration's. */

import { bookingEventGroup, refundEventGroup } from "#accounting/mappers.ts";
import { getDb } from "#db/client.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";

/** The refund legs of one refund event, as (id, link) pairs. */
export const refundLegLinks = async (
  refundGroup: string,
): Promise<{ id: number; reverses_group: string }[]> => {
  const rows = await getDb().execute({
    args: [refundGroup],
    sql:
      "SELECT id, reverses_group FROM transfers WHERE event_group = ?" +
      " AND kind GLOB 'refund_*'",
  });
  return rows.rows.map((row) => ({
    id: Number(row.id),
    reverses_group: String(row.reverses_group),
  }));
};

/** Set one stored link by hand — the backfill must never overwrite it. */
export const forceLegLink = (legId: number, value: string): Promise<unknown> =>
  getDb().execute({
    args: [value, legId],
    sql: "UPDATE transfers SET reverses_group = ? WHERE id = ?",
  });

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
export const stampedReversesOf = async (group: string): Promise<Set<string>> =>
  new Set((await refundLegLinks(group)).map((leg) => leg.reverses_group));

/** The refund event group a booking order's reversals land under, so a test
 *  can ask for the order's stamp without rebuilding it by hand. */
export const refundGroupOfBooking = (bookingGroup: string): Promise<string> =>
  refundEventGroup(bookingGroup);
