/**
 * One-shot backfill of the transfers ledger from existing booking rows.
 *
 * No production modifier or reservation has ever existed, so every historical
 * booking is paid in full: an attendee's `listing_attendees` rows with
 * `price_paid > 0` reconstruct to one `sale` per listing plus a single
 * `payment` for the lot (the attendee nets to zero), and a fully-refunded
 * attendee also gets the matching reversal. One event group per attendee
 * (`backfill:att:<id>`) mirrors the live booking flow — a multi-listing booking
 * is one order — so a later admin refund still finds a single booking order via
 * {@link file://../refund-ledger.ts}.
 *
 * It reuses the live mappers, so references and validation match the dual-write
 * path exactly. Each attendee's legs are written with `INSERT OR IGNORE` keyed
 * on the unique reference, which makes a re-run a no-op, in a batch rather than
 * an interactive transaction so it never contends the single SQLite writer
 * mid-migration.
 */

import { mapBooking, mapRefund } from "#shared/accounting/mappers.ts";
import { insertStatement, orIgnore } from "#shared/accounting/rows.ts";
import { executeBatch, inPlaceholders, queryAll } from "#shared/db/client.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import { toCanonicalIso } from "#shared/payment-helpers.ts";

/** One paid `listing_attendees` row joined to its attendee's booking time. */
type PaidRow = {
  attendee_id: number | bigint;
  listing_id: number | bigint;
  price_paid: number | bigint;
  refunded: number | bigint;
  created: string;
};

/** Attendees are paged so a large booking history never loads all at once. */
const ATTENDEE_PAGE = 500;

/** The next page of attendee ids holding a paid booking row, after `afterId`. */
const nextPaidAttendeeIds = async (afterId: number): Promise<number[]> => {
  const rows = await queryAll<{ attendee_id: number | bigint }>(
    "SELECT DISTINCT attendee_id FROM listing_attendees" +
      " WHERE price_paid > 0 AND attendee_id > ?" +
      " ORDER BY attendee_id LIMIT ?",
    [afterId, ATTENDEE_PAGE],
  );
  return rows.map((row) => Number(row.attendee_id));
};

/** Every paid row for a page of attendees, ordered for stable grouping. */
const paidRowsForAttendees = (ids: number[]): Promise<PaidRow[]> =>
  queryAll<PaidRow>(
    "SELECT la.attendee_id, la.listing_id, la.price_paid, la.refunded," +
      " a.created FROM listing_attendees la" +
      " JOIN attendees a ON a.id = la.attendee_id" +
      ` WHERE la.price_paid > 0 AND la.attendee_id IN (${inPlaceholders(ids)})` +
      " ORDER BY la.attendee_id, la.listing_id",
    ids,
  );

/** Group a page of rows by attendee id, preserving the query's order. */
const groupByAttendee = (rows: PaidRow[]): Map<number, PaidRow[]> => {
  const groups = new Map<number, PaidRow[]>();
  for (const row of rows) {
    const id = Number(row.attendee_id);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
};

/** Build the booking — and, when fully refunded, refund — legs for one attendee. */
const attendeeLegs = async (
  attendeeId: number,
  rows: PaidRow[],
  currency: string,
): Promise<TransferInput[]> => {
  const occurredAt = toCanonicalIso(rows[0]!.created);
  if (occurredAt === undefined) {
    throw new Error(
      `backfill: attendee ${attendeeId} has an unparseable created time ` +
        `"${rows[0]!.created}"`,
    );
  }
  const bookingLegs = await mapBooking({
    amountPaid: rows.reduce((sum, row) => sum + Number(row.price_paid), 0),
    attendeeId,
    bookingFee: 0,
    currency,
    eventId: `backfill:att:${attendeeId}`,
    lines: rows.map((row) => ({
      gross: Number(row.price_paid),
      listingId: Number(row.listing_id),
    })),
    modifiers: [],
    occurredAt,
  });
  // Every historical booking is all-or-nothing (paid in full or refunded in
  // full), so reverse only when every paid line is refunded; a mixed state —
  // which the data guarantees cannot occur — is left booked for a manual check.
  if (!rows.every((row) => Number(row.refunded) !== 0)) return bookingLegs;
  // mapRefund reads only money-identity fields (never id/recordedAt), so the
  // freshly mapped booking legs stand in for the not-yet-stored ones.
  const orderLegs: Transfer[] = bookingLegs.map((leg) => ({
    ...leg,
    id: 0,
    recordedAt: occurredAt,
  }));
  return [...bookingLegs, ...(await mapRefund({ occurredAt, orderLegs }))];
};

/**
 * Backfill the ledger from every existing paid booking, in the site `currency`.
 * Idempotent: deterministic references + `INSERT OR IGNORE` make a re-run write
 * nothing.
 */
export const backfillTransfers = async (currency: string): Promise<void> => {
  let afterId = 0;
  for (;;) {
    const attendeeIds = await nextPaidAttendeeIds(afterId);
    if (attendeeIds.length === 0) return;
    const groups = groupByAttendee(await paidRowsForAttendees(attendeeIds));
    for (const [attendeeId, rows] of groups) {
      const recordedAt = nowIso();
      const legs = await attendeeLegs(attendeeId, rows, currency);
      await executeBatch(
        legs.map((leg) => orIgnore(insertStatement(leg, recordedAt))),
      );
    }
    afterId = attendeeIds[attendeeIds.length - 1]!;
  }
};
