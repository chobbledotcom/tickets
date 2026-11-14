/**
 * Computed entirely in SQL, so the Overview never loads or decrypts a listing's
 * individual attendee rows.
 *
 * The subtle figure is the "incomplete payment" split: a sale leg, no booking
 * payment, no processed reference, nothing still owed, and not refunded. The
 * last two clauses keep settled and refunded bookings out. A refunded
 * balance-paid booking can lose its processed reference once a `refund_cash`
 * leg exists, and would otherwise read as a bare sale.
 */

import { ATTENDEE, REVENUE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  saleLegPredicate,
} from "#accounting/projection-sql.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import {
  LISTING_ATTENDEE_REFUNDED_ROW,
  type RefundedRowExprs,
  refundedForBooking,
} from "#db/attendees/select.ts";
import { requireOne } from "#db/client.ts";
import { type SqlStatement, sql, sqlLiteral } from "#db/sql.ts";
import { isPaidListing, type Listing } from "#types";

/**
 * The collated attendee numbers the Overview tab renders. All figures cover the
 * listing's real (`kind = 'attendee'`) bookings and exclude the incomplete
 * (unpaid-recognised-sale) rows, exactly as the roster's in-memory derivation
 * does — except `incompleteQuantity`, which is that excluded quantity.
 */
export type ListingOverviewStats = {
  /** Σ quantity of incomplete (recognised sale, no payment) bookings. Zero for a
   *  free listing, where no booking can be "incomplete". Subtracted from the
   *  listing's trigger-maintained count to get the confirmed attendee count. */
  incompleteQuantity: number;
  /** Σ quantity of the confirmed (non-incomplete) bookings. */
  completeQuantitySum: number;
  /** Σ quantity of confirmed bookings with a real (> 0) quantity — the
   *  check-in progress denominator in ticket terms. */
  ticketsTotal: number;
  /** Confirmed real-quantity booking rows — the row-terms denominator. */
  rowsTotal: number;
  /** Σ quantity of confirmed, checked-in bookings. */
  ticketsCheckedIn: number;
  /** Confirmed, checked-in booking rows. */
  rowsCheckedIn: number;
  /** Σ of the `sale` legs recognised for incomplete (never-paid) bookings. The
   *  received revenue the Overview shows is the listing's gross sales minus this
   *  — computed by the caller, which already holds the gross figure. Zero for a
   *  free listing (no ledger scan runs). */
  incompleteSales: number;
};

/** SQL predicate: this booking has NOT come back, asked through the same
 * `refundedForBooking` the row projection uses so the two cannot drift. It is
 * here so a refunded booking whose processed reference was later pruned is not
 * mistaken for a bare sale. */
const notRefunded = (row: RefundedRowExprs): SqlStatement =>
  sql`NOT ${refundedForBooking(row)}`;

/** SQL boolean (0/1) marking a `listing_attendees` row `listingAttendee` as an
 *  incomplete payment: a recognised `sale` leg for the booking with no
 *  `payment` leg ever received into the attendee for that same ledger event
 *  group, nothing still owed, and no refund. Only paid listings can carry one,
 *  so `false` collapses the CASE arms for a free listing to their confirmed
 *  side. */
const incompleteRowPredicate = (paid: boolean): SqlStatement => {
  if (!paid) return sql`0`;
  const hasSale = sql`EXISTS (SELECT 1 FROM transfers WHERE ${saleLegPredicate(
    sql`listingAttendee.attendee_id`,
    sql`listingAttendee.listing_id`,
    sql`listingAttendee.ledger_event_group`,
  )})`;
  const hasPayment = sql`EXISTS (SELECT 1 FROM transfers WHERE kind = ${sqlLiteral(
    KIND.payment,
  )} AND ${accountPredicate(
    "dest",
    ATTENDEE,
    sql`listingAttendee.attendee_id`,
  )} AND event_group = listingAttendee.ledger_event_group)`;
  const hasProviderReference = sql`EXISTS (SELECT 1 FROM processed_payments AS payment WHERE payment.attendee_id = listingAttendee.attendee_id AND payment.payment_reference != '')`;
  const nothingOwed = sql`${attendeeOwedSubquery(
    sql`listingAttendee.attendee_id`,
  )} <= 0`;
  return sql`(${hasSale} AND NOT ${hasPayment} AND NOT ${hasProviderReference} AND ${nothingOwed} AND ${notRefunded(LISTING_ATTENDEE_REFUNDED_ROW)})`;
};

type OverviewCountsRow = {
  incomplete_quantity: number | bigint;
  complete_quantity_sum: number | bigint;
  tickets_total: number | bigint;
  rows_total: number | bigint;
  tickets_checked_in: number | bigint;
  rows_checked_in: number | bigint;
};

/** Σ of the `sale` legs recognised into the listing's revenue account for
 *  bookings that never received a payment — the revenue to exclude from the
 *  confirmed total. Zero for a free listing (queried only when paid). */
const incompleteSales = async (listingId: number): Promise<number> => {
  const saleAttendeeId = sql`CAST(saleLeg.source_id AS INTEGER)`;
  const saleToRevenue = sql`saleLeg.kind = ${sqlLiteral(
    KIND.sale,
  )} AND ${accountPredicate("dest", REVENUE, sql`${String(listingId)}`)}`;
  const noPayment = sql`NOT EXISTS (SELECT 1 FROM transfers AS paymentLeg WHERE paymentLeg.kind = ${sqlLiteral(
    KIND.payment,
  )} AND paymentLeg.dest_type = 'attendee' AND paymentLeg.dest_id = saleLeg.source_id AND paymentLeg.event_group = saleLeg.event_group)`;
  const noProviderReference = sql`NOT EXISTS (SELECT 1 FROM processed_payments AS payment WHERE payment.attendee_id = ${saleAttendeeId} AND payment.payment_reference != '')`;
  const nothingOwed = sql`${attendeeOwedSubquery(saleAttendeeId)} <= 0`;
  // Every row here HAS a sale leg — the query reads from them — so the
  // placeholder arm is unreachable and says so rather than guessing a quantity.
  const notRefundedSale = notRefunded({
    attendeeId: saleAttendeeId,
    eventGroup: sql`saleLeg.event_group`,
    listingId: sql`CAST(saleLeg.dest_id AS INTEGER)`,
    placeholderWhen: sql`0`,
  });
  const row = await requireOne<{ incomplete_sales: number | bigint }>(
    sql`SELECT COALESCE(SUM(saleLeg.amount), 0) AS incomplete_sales
       FROM transfers AS saleLeg
      WHERE ${saleToRevenue} AND ${noPayment} AND ${noProviderReference}
        AND ${nothingOwed} AND ${notRefundedSale}`,
  );
  return Number(row.incomplete_sales);
};

/**
 * Load the Overview tab's collated stats for one listing without touching its
 * attendee rows. The caller subtracts {@link ListingOverviewStats.incompleteSales}
 * from the listing's gross sales (which it already holds) to show received
 * revenue.
 */
export const getListingOverviewStats = async (
  listing: Pick<
    Listing,
    "id" | "unit_price" | "can_pay_more" | "customisable_days" | "day_prices"
  >,
): Promise<ListingOverviewStats> => {
  const paid = isPaidListing(listing);
  const incomplete = incompleteRowPredicate(paid);
  const confirmed = sql`NOT ${incomplete} AND listingAttendee.quantity > 0`;
  const countsPromise = requireOne<OverviewCountsRow>(
    sql`SELECT
       COALESCE(SUM(CASE WHEN ${incomplete} THEN listingAttendee.quantity ELSE 0 END), 0) AS incomplete_quantity,
       COALESCE(SUM(CASE WHEN NOT ${incomplete} THEN listingAttendee.quantity ELSE 0 END), 0) AS complete_quantity_sum,
       COALESCE(SUM(CASE WHEN ${confirmed} THEN listingAttendee.quantity ELSE 0 END), 0) AS tickets_total,
       COALESCE(SUM(CASE WHEN ${confirmed} THEN 1 ELSE 0 END), 0) AS rows_total,
       COALESCE(SUM(CASE WHEN ${confirmed} THEN listingAttendee.checked_in ELSE 0 END), 0) AS tickets_checked_in,
       COALESCE(SUM(CASE WHEN ${confirmed} AND listingAttendee.checked_in = listingAttendee.quantity THEN 1 ELSE 0 END), 0) AS rows_checked_in
     FROM listing_attendees AS listingAttendee
     JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id
     WHERE listingAttendee.listing_id = ${listing.id} AND attendee.kind = ${sqlLiteral(ATTENDEE_KIND)}`,
  );
  // Only a paid listing can carry never-paid sales, so a free listing skips the
  // ledger scan entirely.
  const [counts, incompleteSaleTotal] = await Promise.all([
    countsPromise,
    paid ? incompleteSales(listing.id) : Promise.resolve(0),
  ]);
  const row = counts!;
  return {
    completeQuantitySum: Number(row.complete_quantity_sum),
    incompleteQuantity: Number(row.incomplete_quantity),
    incompleteSales: incompleteSaleTotal,
    rowsCheckedIn: Number(row.rows_checked_in),
    rowsTotal: Number(row.rows_total),
    ticketsCheckedIn: Number(row.tickets_checked_in),
    ticketsTotal: Number(row.tickets_total),
  };
};
