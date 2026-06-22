/**
 * One-shot backfill of the transfers ledger from existing booking rows.
 *
 * No production modifier or reservation has ever existed, so every historical
 * booking is paid in full: an attendee's `listing_attendees` rows with
 * `price_paid > 0` reconstruct to one `sale` per listing plus a single
 * `payment` for the lot (the attendee nets to zero), and a refunded attendee
 * also gets the matching reversal. One event group per attendee
 * (`backfill:att:<id>`) mirrors the live booking flow — a multi-listing booking
 * is one order — so a later admin refund still finds a single booking order via
 * {@link file://../refund-ledger.ts}.
 *
 * It reuses the live mappers, so references and validation match the dual-write
 * path exactly. Each attendee's legs are written with `INSERT OR IGNORE` keyed
 * on the unique reference, which makes a re-run a no-op, in a batch rather than
 * an interactive transaction so it never contends the single SQLite writer
 * mid-migration.
 *
 * Two guards keep it safe even though, at the Phase-0 point it runs (the ledger
 * is rebuilt empty by the immediately-preceding migration), neither normally
 * fires: an attendee that already carries ledger legs is skipped, so a booking
 * the live dual-write path already recorded is never double-posted; and legs are
 * written in the currency the ledger already holds when it is non-empty, so a
 * changed site currency can never mix currencies in one ledger.
 */

import type { InValue } from "@libsql/client";
import { mapBooking, mapRefund } from "#shared/accounting/mappers.ts";
import { accountBalancesForIds } from "#shared/accounting/queries.ts";
import {
  fromDb,
  insertStatement,
  ledgerCurrency,
  orIgnore,
} from "#shared/accounting/rows.ts";
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

/** The `attendee` account type — what the receivable legs are keyed under. */
const ATTENDEE = "attendee";

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
    "SELECT listingAttendee.attendee_id, listingAttendee.listing_id," +
      " listingAttendee.price_paid, listingAttendee.refunded, attendee.created" +
      " FROM listing_attendees AS listingAttendee" +
      " JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id" +
      " WHERE listingAttendee.price_paid > 0" +
      ` AND listingAttendee.attendee_id IN (${inPlaceholders(ids)})` +
      " ORDER BY listingAttendee.attendee_id, listingAttendee.listing_id",
    ids,
  );

/** The ids, among `ids`, whose attendee account already has ledger legs — a
 *  booking the live dual-write path recorded, which the backfill must not
 *  repost. An account appears in the balance map iff it has at least one leg. */
const alreadyLedgered = async (ids: number[]): Promise<Set<string>> =>
  new Set((await accountBalancesForIds(ATTENDEE, ids.map(String))).keys());

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

/** Build the booking — and, when refunded, refund — legs for one attendee. */
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
  // A historical refund is a whole-payment provider refund (every booking is
  // paid in full, refunded in full, or free — no partials), but markRefunded
  // flags only the one listing row the admin acted on, so a multi-listing order
  // may carry the flag on a single line. Treat any flagged line as a full-order
  // refund and reverse the whole booking rather than under-reversing it.
  if (!rows.some((row) => Number(row.refunded) !== 0)) return bookingLegs;
  // mapRefund reads only money-identity fields (never id/recordedAt), so the
  // freshly mapped booking legs stand in for the not-yet-stored ones.
  const orderLegs: Transfer[] = bookingLegs.map((leg) => ({
    ...leg,
    id: 0,
    recordedAt: occurredAt,
  }));
  return [...bookingLegs, ...(await mapRefund({ occurredAt, orderLegs }))];
};

/** The UPDATE that links an attendee's booking rows to their order's ledger
 *  event group — what the per-row amount-paid projection keys on. */
const stampStatement = (
  attendeeId: number,
  eventGroup: string,
): { sql: string; args: InValue[] } => ({
  args: [eventGroup, attendeeId],
  sql: "UPDATE listing_attendees SET ledger_event_group = ? WHERE attendee_id = ?",
});

/** Stamp the row→event link for an already-ledgered attendee from their existing
 *  booking's sale leg, in one statement (so no read-then-write and no re-post).
 *  COALESCE to '' when no sale leg exists, which the projection reads as 0. */
const stampFromExistingStatement = (
  attendeeId: number,
): { sql: string; args: InValue[] } => ({
  args: [String(attendeeId), attendeeId],
  sql:
    "UPDATE listing_attendees SET ledger_event_group = COALESCE(" +
    "(SELECT event_group FROM transfers WHERE source_type = 'attendee'" +
    " AND source_id = ? AND kind = 'sale' LIMIT 1), '') WHERE attendee_id = ?",
});

/**
 * Backfill the ledger from every existing paid booking. `siteCurrency` is the
 * currency to post in when the ledger is still empty; a non-empty ledger's own
 * currency wins so the single-currency invariant always holds. Idempotent:
 * already-ledgered attendees are skipped and the deterministic references plus
 * `INSERT OR IGNORE` make a re-run write nothing.
 */
export const backfillTransfers = async (
  siteCurrency: string,
): Promise<void> => {
  const currency = (await ledgerCurrency(fromDb)) ?? siteCurrency;
  let afterId = 0;
  for (;;) {
    const attendeeIds = await nextPaidAttendeeIds(afterId);
    if (attendeeIds.length === 0) return;
    const ledgered = await alreadyLedgered(attendeeIds);
    const groups = groupByAttendee(await paidRowsForAttendees(attendeeIds));
    for (const [attendeeId, rows] of groups) {
      if (ledgered.has(String(attendeeId))) {
        // Already ledgered by the live dual-write path: don't re-post, but still
        // stamp the row→event link from the existing booking's sale leg so the
        // per-row amount-paid projection resolves it. On the shipping path the
        // ledger is empty here, so this branch never runs — it is deploy-order
        // robustness, matching the skip-already-ledgered guard it pairs with.
        await executeBatch([stampFromExistingStatement(attendeeId)]);
        continue;
      }
      const recordedAt = nowIso();
      const legs = await attendeeLegs(attendeeId, rows, currency);
      // Stamp the order's rows with their booking event group (the first leg's,
      // since booking legs precede any refund legs) so the per-row amount-paid
      // projection resolves exactly this booking's sale leg. Folded into the same
      // batch as the inserts so the rows and their legs land together.
      await executeBatch([
        ...legs.map((leg) => orIgnore(insertStatement(leg, recordedAt))),
        stampStatement(attendeeId, legs[0]!.eventGroup),
      ]);
    }
    afterId = attendeeIds[attendeeIds.length - 1]!;
  }
};
