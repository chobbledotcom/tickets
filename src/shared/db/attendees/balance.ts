/**
 * Settle a reserved attendee's outstanding balance.
 *
 * Money is read from the transfers ledger (the outstanding balance projects as
 * −balanceOf(attendee); amounts paid from the booking's sale legs), and the
 * settle posts its own balance-payment leg — no PII and no decryption, so it can
 * run in the keyless payment-webhook context. Idempotent: a second call once the
 * balance is cleared is a no-op.
 */

import type { InValue } from "@libsql/client";
import { compact, mapParallel, sumOf } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { guardedInsertStatement } from "#shared/accounting/rows.ts";
import { decrypt } from "#shared/crypto/encryption.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getPaidDefaultStatus } from "#shared/db/attendee-statuses.ts";
import {
  pricePaidFromLedger,
  remainingBalanceFromLedger,
} from "#shared/db/attendees/queries.ts";
import {
  executeBatchWithResults,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

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
  }>(
    `SELECT status_id, ${remainingBalanceFromLedger("attendees.id")} FROM attendees WHERE id = ?`,
    [attendeeId],
  );
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
            ${pricePaidFromLedger(
              "listingAttendee.attendee_id",
              "listingAttendee.listing_id",
              "listingAttendee.ledger_event_group",
            )},
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
 * remaining balance, move them to the paid-default status, and log the payment.
 * The amount paid is no longer folded into a column — a booking row's amount
 * paid projects from its ledger sale leg, and the paying checkout posts its own
 * payment leg, so the balance settle only has to clear the receivable.
 *
 * `expectedAmount` is the balance the paying checkout was created for. The
 * status move and the balance-payment leg are both guarded on the projected
 * outstanding balance still equalling `expectedAmount`, so a balance edited (or
 * already settled by a racing/stale checkout) after this checkout was created no
 * longer matches and we refuse rather than settle the wrong amount.
 *
 * `extraStatements` are committed in the SAME transaction, between the status
 * move and the payment leg — used to finalize the payment session atomically with
 * the settle (see balanceFinalizeStatement) so a crash between the two can't
 * leave a paid-but-unfinalized row. Each must carry its own balance guard so it
 * no-ops on a mismatch, exactly like the settle writes.
 */
export const settleAttendeeBalance = async (
  attendeeId: number,
  expectedAmount: number,
  settle: { id: string; occurredAt: string },
  extraStatements: { sql: string; args: InValue[] }[] = [],
): Promise<SettleBalanceResult> => {
  const state = await getAttendeeBalanceState(attendeeId);
  if (!state) return { reason: "not_found", settled: false };
  if (state.remainingBalance <= 0)
    return { reason: "nothing_owed", settled: false };

  const paid = await getPaidDefaultStatus();
  // The attendee's outstanding balance, projected from the ledger, used as an
  // atomic guard: both writes below fire only while they still owe exactly
  // `expectedAmount`. A concurrent settle whose payment leg already landed sees
  // owed = 0 and no-ops, so the balance settles exactly once — no stored column.
  const owed = attendeeOwedSubquery(String(attendeeId));
  const results = await executeBatchWithResults([
    {
      // Verdict (first statement): move to the paid status while they still owe
      // the expected amount. A mismatched or already-settled balance matches 0
      // rows, exactly like the old column guard.
      args: [paid?.id ?? null, attendeeId, expectedAmount],
      sql: `UPDATE attendees SET status_id = COALESCE(?, status_id) WHERE id = ? AND ${owed} = ?`,
    },
    ...extraStatements,
    // The balance payment: world funds the attendee, zeroing what they owed.
    // INSERT OR IGNORE on a settle-stable reference plus the same owed guard
    // makes a retried/raced webhook a no-op. Runs after the status move so its
    // guard still sees the pre-payment balance.
    guardedInsertStatement(
      {
        amount: expectedAmount,
        destination: attendeeAccount(attendeeId),
        eventGroup: await eventGroup(["balance", settle.id]),
        kind: "payment",
        occurredAt: settle.occurredAt,
        reference: await legReference(["balance", settle.id, "payment"]),
        source: WORLD,
      },
      nowIso(),
      `${owed} = ?`,
      [expectedAmount],
    ),
  ]);

  // The status move is the verdict; 0 rows means a concurrent/stale callback
  // changed the balance between our read and this write, or the amount differs.
  if (results[0]!.rowsAffected === 0)
    return { reason: "amount_mismatch", settled: false };

  // The logged-activity / returned listing is the attendee's first real line.
  // A settle implies an owed balance, which implies a sale leg, which can only
  // sit on a quantity > 0 line (a paid line can't be marked no-quantity), so a
  // real line normally exists; the lookup stays nullable for a purely
  // ledger-owed attendee with no booking row.
  const firstListing = await queryOne<{ listing_id: number }>(
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
