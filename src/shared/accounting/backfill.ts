/**
 * One-shot backfill of the transfers ledger from existing booking rows.
 *
 * No production modifier or reservation has ever existed, so every historical
 * booking is paid in full: each `listing_attendees` row with `price_paid > 0`
 * reconstructs to a `sale` + `payment` (the attendee nets to zero), plus a full
 * reversal when the row is refunded. It reuses the live mappers, so references
 * and validation match exactly, and the deterministic keys make a re-run a
 * no-op. The `backfill:la:<id>` event id is namespaced so it can never collide
 * with a live booking's session-id or attendee-id event.
 */

import { mapBooking, mapRefund } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { queryAll } from "#shared/db/client.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { toCanonicalIso } from "#shared/payment-helpers.ts";

type BookingRow = {
  la_id: number | bigint;
  listing_id: number | bigint;
  attendee_id: number | bigint;
  price_paid: number | bigint;
  refunded: number | bigint;
  created: string;
};

const BOOKINGS_QUERY =
  "SELECT la.id AS la_id, la.listing_id, la.attendee_id, la.price_paid," +
  " la.refunded, a.created" +
  " FROM listing_attendees la" +
  " JOIN attendees a ON a.id = la.attendee_id" +
  " WHERE la.price_paid > 0" +
  " ORDER BY la.id";

/** Reconstruct and post the ledger legs for one historical paid booking row. */
const backfillBooking = async (
  row: BookingRow,
  currency: string,
): Promise<void> => {
  const occurredAt = toCanonicalIso(row.created);
  if (occurredAt === undefined) {
    throw new Error(
      `backfill: listing_attendee ${row.la_id} has an unparseable created time "${row.created}"`,
    );
  }
  const pricePaid = Number(row.price_paid);
  const bookingLegs = await mapBooking({
    amountPaid: pricePaid,
    attendeeId: Number(row.attendee_id),
    bookingFee: 0,
    currency,
    eventId: `backfill:la:${row.la_id}`,
    lines: [{ gross: pricePaid, listingId: Number(row.listing_id) }],
    modifiers: [],
    occurredAt,
  });
  await postTransfers(bookingLegs);
  if (Number(row.refunded) !== 0) {
    // mapRefund only reads money-identity fields, never id/recordedAt, so the
    // freshly mapped booking legs stand in for the stored ones.
    const orderLegs: Transfer[] = bookingLegs.map((leg) => ({
      ...leg,
      id: 0,
      recordedAt: occurredAt,
    }));
    await postTransfers(await mapRefund({ occurredAt, orderLegs }));
  }
};

/**
 * Backfill the ledger from every existing paid booking row, in the site
 * `currency`. Idempotent: deterministic reference keys make a re-run a no-op.
 */
export const backfillTransfers = async (currency: string): Promise<void> => {
  for (const row of await queryAll<BookingRow>(BOOKINGS_QUERY, [])) {
    await backfillBooking(row, currency);
  }
};
