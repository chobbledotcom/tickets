/**
 * Settle a reserved attendee's outstanding balance.
 *
 * Works entirely off plaintext columns (status_id, remaining_balance,
 * listing_attendees.price_paid), so it can run in the keyless payment-webhook
 * context. Idempotent: a second call once the balance is cleared is a no-op.
 */

import { compact, mapParallel, sumOf } from "#fp";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPaidDefaultStatus } from "#shared/db/attendee-statuses.ts";
import { executeBatch, queryAll, queryOne } from "#shared/db/client.ts";
import { getListingWithCount } from "#shared/db/listings.ts";

/** Plaintext reservation state for an attendee. */
export type AttendeeBalanceState = {
  statusId: number | null;
  remainingBalance: number;
};

/** Read an attendee's status and outstanding balance (no decryption). */
export const getAttendeeBalanceState = async (
  attendeeId: number,
): Promise<AttendeeBalanceState | null> => {
  const row = await queryOne<{
    status_id: number | null;
    remaining_balance: number;
  }>("SELECT status_id, remaining_balance FROM attendees WHERE id = ?", [
    attendeeId,
  ]);
  return row
    ? {
        remainingBalance: Number(row.remaining_balance),
        statusId: row.status_id,
      }
    : null;
};

/** One product line of an attendee's order (no PII). */
export type OrderLine = {
  listingId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  pricePaid: number;
};

/** A PII-free recap of an attendee's order. */
export type OrderSummary = {
  lines: OrderLine[];
  fullPrice: number;
  totalQuantity: number;
  depositPaid: number;
};

/**
 * Build a PII-free recap of an attendee's booked products: line names, the
 * full order price (current listing prices), the quantity and what's been paid
 * so far. Used by the admin balance panel and the public balance page.
 */
type OrderRow = { listing_id: number; quantity: number; price_paid: number };

export const getAttendeeOrderSummary = async (
  attendeeId: number,
): Promise<OrderSummary> => {
  const rows = await queryAll<OrderRow>(
    "SELECT listing_id, quantity, price_paid FROM listing_attendees WHERE attendee_id = ? ORDER BY id",
    [attendeeId],
  );

  // Resolve each line's current listing (concurrently); drop lines whose
  // listing has since been deleted.
  const lines = compact(
    await mapParallel(async (row: OrderRow): Promise<OrderLine | null> => {
      const listing = await getListingWithCount(row.listing_id);
      return listing
        ? {
            listingId: row.listing_id,
            name: listing.name,
            pricePaid: row.price_paid,
            quantity: row.quantity,
            unitPrice: listing.unit_price,
          }
        : null;
    })(rows),
  );

  return {
    depositPaid: sumOf((l: OrderLine) => l.pricePaid)(lines),
    fullPrice: sumOf((l: OrderLine) => l.unitPrice * l.quantity)(lines),
    lines,
    totalQuantity: sumOf((l: OrderLine) => l.quantity)(lines),
  };
};

/** Result of attempting to settle a balance. */
export type SettleBalanceResult =
  | { settled: true; amount: number; listingId: number | null }
  | { settled: false; reason: "not_found" | "nothing_owed" };

/**
 * Mark a reserved attendee as paid: clear the remaining balance, move them to
 * the paid-default status, fold the balance into the booking's recorded
 * price_paid, and log the payment against the attendee.
 */
export const settleAttendeeBalance = async (
  attendeeId: number,
): Promise<SettleBalanceResult> => {
  const state = await getAttendeeBalanceState(attendeeId);
  if (!state) return { reason: "not_found", settled: false };
  if (state.remainingBalance <= 0)
    return { reason: "nothing_owed", settled: false };

  const amount = state.remainingBalance;
  const paid = await getPaidDefaultStatus();

  await executeBatch([
    {
      // Fold the balance into the earliest booking line so the recorded
      // amount-paid reconciles to the full order price.
      args: [amount, attendeeId, attendeeId],
      sql: `UPDATE listing_attendees SET price_paid = price_paid + ?
            WHERE attendee_id = ?
              AND id = (SELECT MIN(id) FROM listing_attendees WHERE attendee_id = ?)`,
    },
    {
      args: [paid?.id ?? null, attendeeId],
      sql: "UPDATE attendees SET remaining_balance = 0, status_id = COALESCE(?, status_id) WHERE id = ?",
    },
  ]);

  const firstListing = await queryOne<{ listing_id: number }>(
    "SELECT listing_id FROM listing_attendees WHERE attendee_id = ? ORDER BY id LIMIT 1",
    [attendeeId],
  );
  const listingId = firstListing ? firstListing.listing_id : null;

  await logActivity(
    `Reservation balance paid: ${formatCurrency(amount)}`,
    listingId,
    attendeeId,
  );

  return { amount, listingId, settled: true };
};
