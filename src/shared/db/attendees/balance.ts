/**
 * Settle a reserved attendee's outstanding balance.
 *
 * Works entirely off plaintext columns (status_id, remaining_balance,
 * listing_attendees.price_paid), so it can run in the keyless payment-webhook
 * context. Idempotent: a second call once the balance is cleared is a no-op.
 */

import type { InValue } from "@libsql/client";
import { compact, mapParallel, sumOf } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPaidDefaultStatus } from "#shared/db/attendee-statuses.ts";
import {
  executeBatchWithResults,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";

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
  listedFullPrice: number;
  totalQuantity: number;
  depositPaid: number;
};

/**
 * Build a PII-free recap of an attendee's booked products: line names, the
 * full order price (current listing prices), the quantity and what's been paid
 * so far. Used by the admin balance panel and the public balance page.
 */
type OrderRow = {
  listing_id: number;
  quantity: number;
  price_paid: number;
  listing_name: string | null;
  listing_unit_price: number | null;
};

const getAttendeeOrderRows = (attendeeId: number): Promise<OrderRow[]> =>
  queryAll<OrderRow>(
    // quantity > 0: a no-quantity sentinel line is not an order line — exclude it
    // so the pay page shows (and checks out against) a real product, never a
    // lower-id ghost.
    `SELECT listingAttendee.listing_id,
            listingAttendee.quantity,
            listingAttendee.price_paid,
            listing.name AS listing_name,
            listing.unit_price AS listing_unit_price
       FROM listing_attendees AS listingAttendee
       LEFT JOIN listings AS listing ON listing.id = listingAttendee.listing_id
      WHERE listingAttendee.attendee_id = ? AND listingAttendee.quantity > 0
      ORDER BY listingAttendee.id`,
    [attendeeId],
  );

const orderLineFromRow = async (row: OrderRow): Promise<OrderLine | null> =>
  row.listing_name === null || row.listing_unit_price === null
    ? null
    : {
        listingId: row.listing_id,
        name: await decrypt(row.listing_name),
        pricePaid: row.price_paid,
        quantity: row.quantity,
        unitPrice: row.listing_unit_price,
      };

export const getAttendeeOrderSummary = async (
  attendeeId: number,
): Promise<OrderSummary> => {
  const [rows, state] = await Promise.all([
    getAttendeeOrderRows(attendeeId),
    getAttendeeBalanceState(attendeeId),
  ]);

  // The LEFT JOIN keeps dangling booking rows visible so we can preserve the
  // previous behavior of dropping lines whose listing has since been deleted.
  const lines = compact(await mapParallel(orderLineFromRow)(rows));

  const depositPaid = sumOf((l: OrderLine) => l.pricePaid)(lines);
  const listedFullPrice = sumOf((l: OrderLine) => l.unitPrice * l.quantity)(
    lines,
  );
  return {
    depositPaid,
    fullPrice: depositPaid + (state?.remainingBalance ?? 0),
    lines,
    listedFullPrice,
    totalQuantity: sumOf((l: OrderLine) => l.quantity)(lines),
  };
};

/** Result of attempting to settle a balance. */
export type SettleBalanceResult =
  | { settled: true; amount: number; listingId: number | null }
  | {
      settled: false;
      reason: "not_found" | "nothing_owed" | "amount_mismatch";
    };

/**
 * Mark a reserved attendee as paid for an exact, verified amount: clear the
 * remaining balance, move them to the paid-default status, fold the amount into
 * the booking's recorded price_paid, and log the payment.
 *
 * `expectedAmount` is the balance the paying checkout was created for. The
 * clear is an atomic conditional update guarded on `remaining_balance =
 * expectedAmount`, so a balance edited (or already settled by a racing/stale
 * checkout) after this checkout was created no longer matches and we refuse
 * rather than clear the wrong amount. The folded price_paid is part of the same
 * batch, conditioned on the same guard, so the two writes never half-apply.
 *
 * `extraStatements` are committed in the SAME transaction, ahead of the
 * balance-clearing write — used to finalize the payment session atomically with
 * the settle (see balanceFinalizeStatement) so a crash between the two can't
 * leave a paid-but-unfinalized row. Each must carry its own balance guard so it
 * no-ops on a mismatch, exactly like the settle writes.
 */
export const settleAttendeeBalance = async (
  attendeeId: number,
  expectedAmount: number,
  extraStatements: { sql: string; args: InValue[] }[] = [],
): Promise<SettleBalanceResult> => {
  const state = await getAttendeeBalanceState(attendeeId);
  if (!state) return { reason: "not_found", settled: false };
  if (state.remainingBalance <= 0)
    return { reason: "nothing_owed", settled: false };
  // A non-zero balance that differs from expectedAmount is handled by the
  // conditional update below (it affects 0 rows), so amount mismatch has a
  // single guard — the atomic write — rather than a racy read-then-check.

  const paid = await getPaidDefaultStatus();

  const results = await executeBatchWithResults([
    ...extraStatements,
    {
      // Fold the paid amount into the earliest booking line so the recorded
      // amount-paid reconciles to the full order price. Guarded on the live
      // balance so it can't apply if a concurrent settlement got there first.
      // Fold onto the lowest-id REAL line (quantity > 0), never a lower-id ghost,
      // so even a mixed attendee records income on a payable line.
      args: [
        expectedAmount,
        attendeeId,
        attendeeId,
        expectedAmount,
        attendeeId,
      ],
      sql: `UPDATE listing_attendees SET price_paid = price_paid + ?
            WHERE attendee_id = ?
              AND (SELECT remaining_balance FROM attendees WHERE id = ?) = ?
              AND id = (SELECT MIN(id) FROM listing_attendees WHERE attendee_id = ? AND quantity > 0)`,
    },
    {
      // Atomic clear: only the callback whose expectedAmount still matches the
      // live balance settles it; a second concurrent callback affects 0 rows.
      // Always the LAST statement, so its rowsAffected is the settle verdict.
      // The EXISTS real-line guard makes the clear conditional on the fold above
      // having a line to land on: if the last real line was marked no-quantity
      // after checkout, the fold hits 0 rows and this clear must NOT finalize the
      // balance with no income recorded — so it too affects 0 rows (mismatch).
      args: [paid?.id ?? null, attendeeId, expectedAmount, attendeeId],
      sql: `UPDATE attendees SET remaining_balance = 0, status_id = COALESCE(?, status_id)
            WHERE id = ? AND remaining_balance = ?
              AND EXISTS (SELECT 1 FROM listing_attendees WHERE attendee_id = ? AND quantity > 0)`,
    },
  ]);

  // The clear is the final statement; 0 rows means a concurrent/stale callback
  // changed the balance between our read and this write.
  if (results[results.length - 1]!.rowsAffected === 0)
    return { reason: "amount_mismatch", settled: false };

  const firstListing = await queryOne<{ listing_id: number }>(
    // The logged-activity / returned listing must be the real line the fold
    // landed on, never a lower-id ghost.
    "SELECT listing_id FROM listing_attendees WHERE attendee_id = ? AND quantity > 0 ORDER BY id LIMIT 1",
    [attendeeId],
  );
  const listingId = firstListing ? firstListing.listing_id : null;

  await logActivity(
    `Reservation balance paid: ${formatCurrency(expectedAmount)}`,
    listingId,
    attendeeId,
  );

  return { amount: expectedAmount, listingId, settled: true };
};
