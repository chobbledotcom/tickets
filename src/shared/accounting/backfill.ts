/**
 * One-shot backfill of the transfers ledger from existing booking rows.
 *
 * No production modifier or reservation has ever existed, so every historical
 * booking is paid in full: rows with `price_paid > 0` reconstruct to one `sale`
 * per listing plus a single `payment` for the lot, and a refunded attendee gets
 * the matching reversal. One event group per attendee mirrors the live flow, so
 * a later refund still finds a single booking order. It reuses the live
 * mappers, so references and validation match the dual-write path exactly.
 *
 * A whole page of attendees goes in one batch (see {@link ATTENDEE_PAGE}): this
 * runs inline on an edge isolate whose subrequest budget a
 * round-trip-per-attendee backfill would blow on real booking history, evicting
 * the isolate mid-run and leaving the migration lock held. An attendee's legs
 * and row-stamp always land together, so each posts all-or-nothing — which is
 * what lets the guard read "has legs" as "fully posted". Legs use
 * `INSERT OR IGNORE` on the unique reference, so a re-run is a no-op.
 *
 * That guard skips an attendee already carrying legs, so a booking the live
 * path recorded is never double-posted. Currency needs no guard: a site has
 * one, fixed at setup.
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { sumOf } from "#fp";
import { ATTENDEE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  asOrderLegs,
  mapBooking,
  mapRefund,
} from "#shared/accounting/mappers.ts";
import { accountBalancesForIds } from "#shared/accounting/queries.ts";
import { insertStatement, orIgnore } from "#shared/accounting/rows.ts";
import {
  executeBatch,
  inPlaceholders,
  queryAll,
  queryIdColumn,
  type SqlStatement,
} from "#shared/db/client.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { nowIso } from "#shared/now.ts";
import { toCanonicalIso } from "#shared/payment-helpers.ts";

/* jscpd:ignore-end */

/** One paid `listing_attendees` row joined to its attendee's booking time. */
type PaidRow = {
  attendee_id: number | bigint;
  listing_id: number | bigint;
  price_paid: number | bigint;
  refunded: number | bigint;
  created: string;
};

/** A leg INSERT or row-stamp UPDATE the backfill writes to the database. */

/**
 * Attendees are paged so a large booking history never loads all at once, and
 * each page's legs are written in a single batch (one libsql round-trip), so the
 * backfill costs O(pages) edge subrequests instead of one per attendee — a
 * round-trip-per-attendee backfill blew the inline migration's subrequest budget
 * and got the isolate evicted mid-run (lock held → endless 503s). A big page
 * keeps that round-trip count low on large sites.
 *
 * The cap is libsql's 32766 bound-variable limit: {@link alreadyLedgered}'s
 * balance query lists the page's ids twice (as source and as destination), so a
 * page may hold at most ~16k attendees. 5000 leaves wide margin while still
 * clearing a 100k-attendee site in ~20 round-trips. The per-page write batch
 * (~5000 attendees × a few legs each) is well within what one libsql batch
 * handles — the legs are PII-free, so there is none of the per-row encryption
 * that makes the seed path chunk for memory.
 */
const ATTENDEE_PAGE = 5000;

/** The next page of attendee ids holding a paid booking row, after `afterId`. */
const nextPaidAttendeeIds = (
  afterId: number,
  pageSize: number,
): Promise<number[]> =>
  queryIdColumn(
    "SELECT DISTINCT attendee.attendee_id AS id" +
      " FROM listing_attendees AS attendee" +
      " WHERE attendee.price_paid > 0 AND attendee.attendee_id > ?" +
      " ORDER BY attendee.attendee_id LIMIT ?",
    [afterId, pageSize],
  );

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

/** Build the booking — and, when refunded, refund — legs for one attendee. */
const attendeeLegs = async (
  attendeeId: number,
  rows: PaidRow[],
): Promise<TransferInput[]> => {
  const occurredAt = toCanonicalIso(rows[0]!.created);
  if (occurredAt === undefined) {
    throw new Error(
      `backfill: attendee ${attendeeId} has an unparseable created time ` +
        `"${rows[0]!.created}"`,
    );
  }
  const bookingLegs = await mapBooking({
    amountPaid: sumOf((row: PaidRow) => Number(row.price_paid))(rows),
    attendeeId,
    bookingFee: 0,
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
  const refundLegs = await mapRefund({
    occurredAt,
    orderLegs: asOrderLegs(bookingLegs, occurredAt),
  });
  return [...bookingLegs, ...refundLegs];
};

/** The UPDATE that writes an attendee's rows' `ledger_event_group` link — what
 *  the per-row amount-paid projection keys on. `valueSql` is the SQL expression
 *  producing the event group; its bound args come before the attendee id. */
const stampUpdate = (valueSql: string, args: InValue[]): SqlStatement => ({
  args,
  sql: `UPDATE listing_attendees SET ledger_event_group = ${valueSql} WHERE attendee_id = ?`,
});

/** Stamp the row→event link with a known event group (a just-built booking's). */
const stampStatement = (attendeeId: number, eventGroup: string): SqlStatement =>
  stampUpdate("?", [eventGroup, attendeeId]);

/** Stamp the row→event link for an already-ledgered attendee from their existing
 *  booking's sale leg, in one statement (so no read-then-write and no re-post).
 *  COALESCE to '' when no sale leg exists, which the projection reads as 0. */
const stampFromExistingStatement = (attendeeId: number): SqlStatement =>
  stampUpdate(
    "COALESCE(" +
      "(SELECT transfer.event_group FROM transfers AS transfer" +
      ` WHERE transfer.source_type = '${ATTENDEE}'` +
      ` AND transfer.source_id = ? AND transfer.kind = '${KIND.sale}'` +
      ` LIMIT 1), '')`,
    [String(attendeeId), attendeeId],
  );

/** The leg-INSERT and row-stamp statements for one not-yet-ledgered attendee.
 *  The stamp uses the order's booking event group (the first leg's, since
 *  booking legs precede any refund legs) so the per-row amount-paid projection
 *  resolves exactly this booking's sale leg; it sits in the same group as the
 *  inserts so the rows and their legs always land in one batch together. */
const attendeeStatements = async (
  attendeeId: number,
  rows: PaidRow[],
  recordedAt: string,
): Promise<SqlStatement[]> => {
  const legs = await attendeeLegs(attendeeId, rows);
  return [
    ...legs.map((leg) => orIgnore(insertStatement(leg, recordedAt))),
    stampStatement(attendeeId, legs[0]!.eventGroup),
  ];
};

/**
 * Backfill the ledger from every existing paid booking. Idempotent:
 * already-ledgered attendees are skipped and the deterministic references plus
 * `INSERT OR IGNORE` make a re-run write nothing. `pageSize` (the per-batch
 * attendee count, defaulting to the edge-budget {@link ATTENDEE_PAGE}) is
 * lowered in tests to exercise the multi-page cursor.
 */
export const backfillTransfers = async (
  pageSize: number = ATTENDEE_PAGE,
): Promise<void> => {
  let afterId = 0;
  for (;;) {
    const attendeeIds = await nextPaidAttendeeIds(afterId, pageSize);
    if (attendeeIds.length === 0) return;
    const ledgered = await alreadyLedgered(attendeeIds);
    const groups = Map.groupBy(await paidRowsForAttendees(attendeeIds), (row) =>
      Number(row.attendee_id),
    );
    const recordedAt = nowIso();
    const statements: SqlStatement[] = [];
    for (const [attendeeId, rows] of groups) {
      // Already ledgered by the live dual-write path: don't re-post, but still
      // stamp the row→event link from the existing booking's sale leg so the
      // per-row amount-paid projection resolves it. On the shipping path the
      // ledger is empty here, so this branch never runs — it is deploy-order
      // robustness, matching the skip-already-ledgered guard it pairs with.
      statements.push(
        ...(ledgered.has(String(attendeeId))
          ? [stampFromExistingStatement(attendeeId)]
          : await attendeeStatements(attendeeId, rows, recordedAt)),
      );
    }
    // The whole page in one batch (one round-trip): each attendee's legs and
    // stamp stay together in a single transaction, and the migration spends
    // O(pages) edge subrequests rather than one per attendee.
    await executeBatch(statements);
    afterId = attendeeIds[attendeeIds.length - 1]!;
  }
};
