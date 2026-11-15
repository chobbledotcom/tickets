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

import { REVENUE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  attendeeOwedSubquery,
  ledgerLegs,
  onAccount,
  paymentLegExists,
  saleLeg,
} from "#accounting/projection-sql.ts";
import { ATTENDEE_KIND } from "#db/attendees/kind.ts";
import {
  BOOKING_ROW,
  type RefundedRowExprs,
  refundedForBooking,
  refundedRowOf,
} from "#db/attendees/select.ts";
import { requireOne } from "#db/client.ts";
import type { WholeNumberRow } from "#db/query.ts";
import {
  and,
  atMost,
  type Expr,
  equal,
  literal,
  not,
  notEqual,
  orZero,
  sum,
  valued,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
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

/** A provider reference stands for the attendee's payment. */
const hasProviderReference = (attendeeId: Expr<number>): Expr<boolean> =>
  from(tables.processed_payments)
    .where((payment) => [
      equal(payment.attendee_id, attendeeId),
      notEqual(payment.payment_reference, literal("")),
    ])
    .exists();

/** A sale that looks paid with no payment on record: no payment leg, no
 *  provider reference, nothing still owed, and no refund. The refund test is
 *  the `refundedForBooking` of the row projection, so the two cannot drift. A
 *  refunded booking whose provider reference was pruned must not read as a
 *  bare sale. */
const unpaidButSettled = (
  row: RefundedRowExprs,
  hasPayment: Expr<boolean>,
): Expr<boolean> =>
  and(
    not(hasPayment),
    not(hasProviderReference(row.attendeeId)),
    atMost(attendeeOwedSubquery(row.attendeeId), literal(0)),
    not(refundedForBooking(row)),
  );

/** Marks the `listing_attendees` row `listingAttendee` as an incomplete
 *  payment: a recognised `sale` leg with no `payment` leg in the same ledger
 *  event group, and {@link unpaidButSettled}. Only a paid listing can carry
 *  one, so a free listing reads every row as confirmed. */
const incompleteRowPredicate = (paid: boolean): Expr<boolean> => {
  if (!paid) return and(false);
  const row = refundedRowOf(BOOKING_ROW);
  const hasSale = ledgerLegs()
    .where(saleLeg(row.attendeeId, row.listingId, row.eventGroup))
    .exists();
  return and(
    hasSale,
    unpaidButSettled(row, paymentLegExists(row.attendeeId, row.eventGroup)),
  );
};

type OverviewCountsRow = WholeNumberRow<
  | "incomplete_quantity"
  | "complete_quantity_sum"
  | "tickets_total"
  | "rows_total"
  | "tickets_checked_in"
  | "rows_checked_in"
>;

/** Σ of the `sale` legs recognised into the listing's revenue account for
 *  bookings that never received a payment — the revenue to exclude from the
 *  confirmed total. Zero for a free listing (queried only when paid). */
const incompleteSales = async (listingId: number): Promise<number> => {
  const row = await requireOne(
    ledgerLegs()
      .as("saleLeg")
      .where((sale) => {
        const attendeeId = valued<number>(
          sql`CAST(${sale.source_id} AS INTEGER)`,
        );
        return [
          equal(sale.kind, literal(KIND.sale)),
          onAccount("dest", REVENUE, String(listingId))(sale),
          // Every row here has a sale leg, so no row is a placeholder.
          unpaidButSettled(
            {
              attendeeId,
              eventGroup: sale.event_group,
              listingId: valued<number>(sql`CAST(${sale.dest_id} AS INTEGER)`),
              placeholderWhen: false,
            },
            paymentLegExists(sale.source_id, sale.event_group),
          ),
        ];
      })
      .select((sale) => ({ incomplete_sales: orZero(sum(sale.amount)) })),
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
  const confirmed = sql`NOT (${incomplete}) AND listingAttendee.quantity > 0`;
  const countsPromise = requireOne<OverviewCountsRow>(
    sql`SELECT
       COALESCE(SUM(CASE WHEN ${incomplete} THEN listingAttendee.quantity ELSE 0 END), 0) AS incomplete_quantity,
       COALESCE(SUM(CASE WHEN NOT (${incomplete}) THEN listingAttendee.quantity ELSE 0 END), 0) AS complete_quantity_sum,
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
