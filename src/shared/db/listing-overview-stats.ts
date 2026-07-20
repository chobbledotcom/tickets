/**
 * Collated Overview-tab statistics for a single listing, computed entirely in
 * SQL from the trigger-maintained columns and the transfers ledger — so the
 * Overview never loads (nor decrypts) a listing's individual attendee rows.
 *
 * The one figure that historically forced a full attendee scan was the
 * "incomplete payment" split: a booking that recognised a sale but never linked
 * any provider payment reference. Legacy paid checkouts carry the ledger shadow
 * (`sale` plus `payment` in the booking group); balance-paid/provider-less
 * checkouts carry a processed payment reference. So "incomplete" is a recognised
 * sale with neither a booking-group payment nor a processed provider reference,
 * that still owes money and was never refunded:
 *
 *   incomplete  ⇔  sale leg AND no booking payment AND no processed reference
 *                  AND nothing still owed AND not refunded
 *
 * The last two clauses keep already-settled and already-refunded bookings out:
 * a refunded balance-paid booking can have its processed reference pruned once a
 * `refund_cash` leg exists, which would otherwise make it look like a bare sale.
 *
 * Everything the Overview shows is derived from that split plus the plain
 * quantity/check-in columns, matching the pre-existing template derivation
 * (`computeAttendeeStats` / `getCheckedInStats` / `calculateTotalRevenue`) row
 * for row while reading only aggregates.
 */

/* jscpd:ignore-start */
import { ATTENDEE, REVENUE } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountPredicate,
  attendeeOwedSubquery,
  saleLegPredicate,
} from "#shared/accounting/projection-sql.ts";
import { ATTENDEE_KIND } from "#shared/db/attendees/kind.ts";
import { ordinaryAttendeeCondition } from "#shared/db/attendees/ordinary.ts";
import { requireOne } from "#shared/db/client.ts";
import type { Listing } from "#shared/types.ts";
import { isPaidListing } from "#shared/types.ts";

/* jscpd:ignore-end */

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

/** SQL predicate: the attendee has NOT been refunded — no `refund_cash` leg
 *  sourced from their account. Mirrors `refundedFromLedger` in
 *  `attendees/queries.ts` (minus its `AS refunded` alias) so a refunded booking
 *  whose processed reference was later pruned is not mistaken for a bare sale. */
const notRefunded = (attendeeIdExpr: string): string =>
  `NOT EXISTS (SELECT 1 FROM transfers WHERE kind = '${KIND.refundCash}'` +
  ` AND ${accountPredicate("source", ATTENDEE, attendeeIdExpr)})`;

/** SQL boolean (0/1) marking a `listing_attendees` row `listingAttendee` as an
 *  incomplete payment: a recognised `sale` leg for the booking with no
 *  `payment` leg ever received into the attendee for that same ledger event
 *  group, nothing still owed, and no refund. Only paid listings can carry one,
 *  so `false` collapses the CASE arms for a free listing to their confirmed
 *  side. */
const incompleteRowPredicate = (paid: boolean): string => {
  if (!paid) return "0";
  const hasSale = `EXISTS (SELECT 1 FROM transfers WHERE ${saleLegPredicate(
    "listingAttendee.attendee_id",
    "listingAttendee.listing_id",
    "listingAttendee.ledger_event_group",
  )})`;
  const hasPayment =
    `EXISTS (SELECT 1 FROM transfers WHERE kind = '${KIND.payment}'` +
    ` AND ${accountPredicate(
      "dest",
      ATTENDEE,
      "listingAttendee.attendee_id",
    )}` +
    " AND event_group = listingAttendee.ledger_event_group)";
  const hasProviderReference =
    "EXISTS (SELECT 1 FROM processed_payments AS payment" +
    " WHERE payment.attendee_id = listingAttendee.attendee_id" +
    " AND payment.payment_reference != '')";
  const nothingOwed = `${attendeeOwedSubquery(
    "listingAttendee.attendee_id",
  )} <= 0`;
  return (
    `(${hasSale} AND NOT ${hasPayment} AND NOT ${hasProviderReference}` +
    ` AND ${nothingOwed} AND ${notRefunded("listingAttendee.attendee_id")})`
  );
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
  const saleToRevenue = `saleLeg.kind = '${KIND.sale}' AND ${accountPredicate(
    "dest",
    REVENUE,
    "?",
  )}`;
  const noPayment =
    `NOT EXISTS (SELECT 1 FROM transfers AS paymentLeg WHERE paymentLeg.kind = '${KIND.payment}'` +
    " AND paymentLeg.dest_type = 'attendee' AND paymentLeg.dest_id = saleLeg.source_id" +
    " AND paymentLeg.event_group = saleLeg.event_group)";
  const noProviderReference =
    "NOT EXISTS (SELECT 1 FROM processed_payments AS payment" +
    " WHERE payment.attendee_id = CAST(saleLeg.source_id AS INTEGER)" +
    " AND payment.payment_reference != '')";
  const nothingOwed = `${attendeeOwedSubquery(
    "CAST(saleLeg.source_id AS INTEGER)",
  )} <= 0`;
  const notRefundedSale = notRefunded("CAST(saleLeg.source_id AS INTEGER)");
  const row = await requireOne<{ incomplete_sales: number | bigint }>(
    `SELECT COALESCE(SUM(saleLeg.amount), 0) AS incomplete_sales
       FROM transfers AS saleLeg
      WHERE ${saleToRevenue} AND ${noPayment} AND ${noProviderReference}
        AND ${nothingOwed} AND ${notRefundedSale}`,
    [String(listingId)],
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
  const confirmed = `NOT ${incomplete} AND listingAttendee.quantity > 0`;
  const countsPromise = requireOne<OverviewCountsRow>(
    `SELECT
       COALESCE(SUM(CASE WHEN ${incomplete} THEN listingAttendee.quantity ELSE 0 END), 0) AS incomplete_quantity,
       COALESCE(SUM(CASE WHEN NOT ${incomplete} THEN listingAttendee.quantity ELSE 0 END), 0) AS complete_quantity_sum,
       COALESCE(SUM(CASE WHEN ${confirmed} THEN listingAttendee.quantity ELSE 0 END), 0) AS tickets_total,
       COALESCE(SUM(CASE WHEN ${confirmed} THEN 1 ELSE 0 END), 0) AS rows_total,
       COALESCE(SUM(CASE WHEN ${confirmed} AND listingAttendee.checked_in = 1 THEN listingAttendee.quantity ELSE 0 END), 0) AS tickets_checked_in,
       COALESCE(SUM(CASE WHEN ${confirmed} AND listingAttendee.checked_in = 1 THEN 1 ELSE 0 END), 0) AS rows_checked_in
     FROM listing_attendees AS listingAttendee
     JOIN attendees AS attendee ON attendee.id = listingAttendee.attendee_id
      WHERE listingAttendee.listing_id = ? AND attendee.kind = '${ATTENDEE_KIND}'
        AND ${ordinaryAttendeeCondition("attendee")}`,
    [listing.id],
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
