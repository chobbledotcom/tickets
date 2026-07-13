/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { unique } from "#fp";
import { t } from "#i18n";
import { type OrderBooking, orderBookings } from "#shared/booking-lines.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type { CreateAttendeeSuccess } from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#shared/db/attendees/api.ts";
import { DEPENDENT_ROW_TARGETS } from "#shared/db/attendees/delete.ts";
import {
  execute,
  executeBatchWithResults,
  inPlaceholders,
  insert,
  primaryMatchingIdSet,
  queryOnePrimary,
  type TxScope,
} from "#shared/db/client.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings/records.ts";
import {
  decryptSessionTokens,
  encryptTicketTokens,
} from "#shared/db/processed-payments.ts";
import { nowIso } from "#shared/now.ts";
import { toBookingItems } from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  CheckoutSessionResult,
  PaymentProvider,
  PaymentProviderType,
} from "#shared/payments.ts";

/* jscpd:ignore-end */

const CheckoutStageStateSchema = v.picklist(["pending", "booked", "failed"]);
export type CheckoutStageState = v.InferOutput<typeof CheckoutStageStateSchema>;

type CheckoutStageRow = {
  attendee_id: number;
  state: CheckoutStageState;
  ticket_tokens: EnvKeyEncrypted;
};

export type CheckoutStage = {
  attendeeId: number;
  state: CheckoutStageState;
  ticketToken: string;
};

/** The order's real-quantity bookings from the signed intent — the single
 * source both the availability preflight and the quantity-0 staging derive
 * from, so what we check is exactly what we stage. */
const orderedBookings = async (
  intent: CheckoutIntent,
): Promise<OrderBooking[]> => {
  const items = toBookingItems(intent);
  const listings = await getListingsWithCountsByIds(
    unique(items.map((item) => item.e)),
  );
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const lines = items.map((item) => {
    const listing = listingById.get(item.e);
    if (!listing) throw new Error(`Listing ${item.e} vanished before checkout`);
    return { item, listing };
  });
  return orderBookings(lines, { ...intent, items });
};

const stagedBookings = async (
  intent: CheckoutIntent,
): Promise<OrderBooking[]> =>
  (await orderedBookings(intent)).map((booking) => ({
    ...booking,
    quantity: 0,
  }));

/** Refuse a checkout whose order provably can't be booked — no room for its real
 * quantities, or a listing that's off sale — BEFORE the provider session is
 * created, so the customer is told up front instead of paying and being
 * refunded. The staged rows themselves claim nothing (quantity 0), so the
 * authoritative capacity claim still runs at activation with the real
 * quantities; this only stops a checkout that cannot succeed. Returns the error
 * to show, or null when the order is bookable. */
const stageableRefusal = async (
  intent: CheckoutIntent,
): Promise<{ error: string } | null> => {
  const bookings = await orderedBookings(intent);
  const available = await checkBatchAvailability(
    bookings.map((booking) => ({
      durationDays: booking.durationDays,
      listingId: booking.listingId,
      quantity: booking.quantity,
    })),
    intent.date,
  );
  return available ? null : { error: t("public.checkout_unavailable") };
};

const stageInsert = async (
  tx: TxScope,
  sessionId: string,
  attendeeId: number,
  provider: PaymentProviderType,
  ticketToken: string,
): Promise<void> => {
  await tx.execute(
    insert("checkout_stages", {
      attendee_id: attendeeId,
      created_at: nowIso(),
      payment_session_id: sessionId,
      provider,
      state: "pending",
      ticket_tokens: await encryptTicketTokens([ticketToken]),
    }),
  );
};

/** Save a fresh checkout as one attendee with exact quantity-zero path rows. */
export const stageCheckout = async (
  sessionId: string,
  provider: PaymentProviderType,
  intent: CheckoutIntent,
): Promise<CheckoutStage> => {
  const ticketToken = generateTicketToken();
  // The overbook insert below cannot refuse (see CreateAttendeeSuccess), so
  // the result is the success arm by construction.
  const result = (await createAttendeeAtomic(
    {
      address: intent.address,
      // A quantity-0 staged row claims nothing, so it must never be capacity
      // gated: an already-overbooked listing (a supported admin state) or one
      // deactivated mid-checkout would otherwise refuse to even START the
      // checkout. Real capacity is enforced at activation, with the real
      // quantities — that check refusing is what the refund path is for.
      allowOverbook: true,
      bookings: await stagedBookings(intent),
      email: intent.email,
      name: intent.name,
      phone: intent.phone,
      source: "public",
      special_instructions: intent.special_instructions,
      statusId: await getPublicStatusId(),
      ticketToken,
    },
    (tx, attendeeId) =>
      stageInsert(tx, sessionId, attendeeId, provider, ticketToken),
  )) as CreateAttendeeSuccess;
  return {
    attendeeId: result.attendees[0]!.id,
    state: "pending",
    ticketToken,
  };
};

/** Check the order is bookable, create the provider session, then stage it
 * before exposing the checkout URL. The order is refused up front when its
 * listings can't fit the real quantities or are off sale, so no unbookable order
 * ever reaches the provider. Only NEW bookings run through here — a balance
 * payment settles an existing booking and goes straight to the provider
 * (`balance.ts`), never staging a fresh attendee — so this always validates and
 * stages. */
export const createStagedCheckout = async (
  provider: PaymentProvider,
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<CheckoutSessionResult> => {
  const refusal = await stageableRefusal(intent);
  if (refusal) return refusal;
  const result = await provider.createCheckoutSession(intent, baseUrl);
  if (!result || "error" in result) return result;
  await stageCheckout(result.sessionId, provider.type, intent);
  return result;
};

/** The session-creator callback {@link runCheckoutFlow} expects: stage this
 * order at quantity zero, then create the provider checkout for it. Curried so
 * every checkout entry point injects staging the same way. */
export const stagedSessionCreator =
  (intent: CheckoutIntent) => (provider: PaymentProvider, baseUrl: string) =>
    createStagedCheckout(provider, intent, baseUrl);

export const getCheckoutStageOrNull = async (
  sessionId: string,
): Promise<CheckoutStage | null> => {
  const row = await queryOnePrimary<
    CheckoutStageRow & { attendee_exists: number | null }
  >(
    `SELECT stage.attendee_id, stage.state, stage.ticket_tokens,
            attendee.id AS attendee_exists
       FROM checkout_stages AS stage
       LEFT JOIN attendees AS attendee ON attendee.id = stage.attendee_id
      WHERE stage.payment_session_id = ?`,
    [sessionId],
  );
  if (!row) return null;
  const parsedState = v.parse(CheckoutStageStateSchema, row.state);
  // A PENDING stage whose attendee is gone is an IMPOSSIBLE state: every
  // deletion path removes the stage with the attendee (deleteAttendee cascades
  // it; the prune deletes both), admin edits/merges/deletes are blocked while
  // pending, and a listing can't be deleted while it has a pending checkout. So
  // a dangling pending stage means a delete skipped the stage cascade — surface
  // the bug, don't silently book fresh around it. (A RESOLVED (booked/failed)
  // dangling stage is returned as-is, so the resolved-stage guard still refuses
  // to re-process money already handled.)
  if (row.attendee_exists === null && parsedState === "pending") {
    throw new Error(
      `Checkout stage for session ${sessionId} points at deleted attendee ${row.attendee_id} while still pending — a pending stage must never outlive its attendee`,
    );
  }
  const ticketToken = await decryptSessionTokens(row.ticket_tokens);
  if (!ticketToken) throw new Error(`Checkout stage ${sessionId} has no token`);
  return {
    attendeeId: row.attendee_id,
    state: parsedState,
    ticketToken,
  };
};

/**
 * Which of these attendees are mid-payment: their checkout is staged and the
 * customer may still be paying. Admin mutations (edits, merges, deletes) must
 * leave such records alone — the payment claims the exact staged rows when it
 * lands, so changing OR removing them strands the paid order. Array in, set out
 * — call with one id for the single case.
 */
// Pinned to the primary: this gates mutations, and a replica lagging the
// just-staged insert would let an edit slip through the guard.
export const attendeeIdsWithPendingStage = primaryMatchingIdSet(
  (placeholders) =>
    `SELECT attendee_id AS id FROM checkout_stages
      WHERE state = 'pending' AND attendee_id IN (${placeholders})`,
);

/** Does this listing have any attendee mid-payment (a pending staged checkout)?
 * Gates listing deletion: deleting a listing removes its booking rows but leaves
 * the attendee behind, which would strand a pending stage's payment (its rows
 * vanish, so the claim can never land). Primary-pinned, like the mutation guard
 * above — a replica lagging a just-staged insert must not let the delete slip. */
export const listingHasPendingCheckout = async (
  listingId: number,
): Promise<boolean> =>
  (await queryOnePrimary<{ one: number }>(
    `SELECT 1 AS one
       FROM checkout_stages AS stage
       JOIN listing_attendees AS booking ON booking.attendee_id = stage.attendee_id
      WHERE stage.state = 'pending' AND booking.listing_id = ?
      LIMIT 1`,
    [listingId],
  )) !== null;

/** Whether this one attendee is mid-payment — a pending staged checkout the
 * payment may still claim. Single-id form of {@link attendeeIdsWithPendingStage}
 * for the admin-edit guards that block a save while the payment is in flight. */
export const hasPendingCheckout = async (
  attendeeId: number,
): Promise<boolean> =>
  (await attendeeIdsWithPendingStage([attendeeId])).has(attendeeId);

export const markCheckoutStage = async (
  sessionId: string,
  state: CheckoutStageState = "failed",
): Promise<void> => {
  await execute(
    "UPDATE checkout_stages SET state = ? WHERE payment_session_id = ?",
    [state, sessionId],
  );
};

/** Resolve a stage a crash left pending after its money was already recorded.
 * Guarded to pending so a booked stage is never downgraded, and a session with
 * no stage is a no-op. Called when the ledger preflight answers "already
 * handled": the outcome is known, so the record must not read as mid-payment
 * forever — a pending stage blocks edits and merges and holds the staged
 * details unprunable. */
export const resolvePendingStage = async (sessionId: string): Promise<void> => {
  await execute(
    `UPDATE checkout_stages SET state = 'failed'
      WHERE payment_session_id = ? AND state = 'pending'`,
    [sessionId],
  );
};

/** The attendee holding a session's still-pending stage, or null when nothing
 * is pending — the expected case for almost every replayed session. Read on
 * the primary: the answer decides whether the healing note is written. */
export const pendingStageAttendeeIdOrNull = async (
  sessionId: string,
): Promise<number | null> => {
  const row = await queryOnePrimary<{ attendee_id: number }>(
    `SELECT attendee_id FROM checkout_stages
      WHERE payment_session_id = ? AND state = 'pending'`,
    [sessionId],
  );
  return row?.attendee_id ?? null;
};

const pendingStageAttendees = (where: string): string =>
  `SELECT stage.attendee_id
     FROM checkout_stages AS stage
    WHERE stage.state = 'pending'
      AND ${where}
      AND NOT EXISTS (
        SELECT 1
          FROM processed_payments AS payment
         WHERE payment.payment_session_id = stage.payment_session_id
      )`;

/** Delete pending checkout PII only while no payment request has claimed it. */
const discardPendingCheckoutsWhere = async (
  where: string,
  args: InValue[],
): Promise<number> => {
  const attendeeIds = pendingStageAttendees(where);
  const results = await executeBatchWithResults([
    // Every table that hangs off an attendee, from the one shared declaration
    // (delete.ts), so a future dependent table cannot leak rows through the
    // discard. The stage rows themselves go LAST: every statement here finds
    // its attendees through the still-present checkout_stages rows (the
    // subquery reads only checkout_stages and processed_payments, so deleting
    // attendees first does not disturb it).
    ...DEPENDENT_ROW_TARGETS.filter(
      (target) => target.table !== "checkout_stages",
    ).map((target) => ({
      args,
      sql: `DELETE FROM ${target.table} WHERE ${target.field} IN (${attendeeIds})`,
    })),
    {
      args,
      sql: `DELETE FROM attendees WHERE id IN (${attendeeIds})`,
    },
    {
      args,
      sql: `DELETE FROM checkout_stages WHERE attendee_id IN (${attendeeIds})`,
    },
  ]);
  return results[results.length - 1]!.rowsAffected;
};

/** Discard one or more cancelled sessions through the same atomic path. */
export const discardPendingCheckoutSessions = (
  sessionIds: string[],
): Promise<number> =>
  sessionIds.length === 0
    ? Promise.resolve(0)
    : discardPendingCheckoutsWhere(
        `stage.payment_session_id IN (${inPlaceholders(sessionIds)})`,
        sessionIds,
      );

/** Remove abandoned pending checkouts older than the retention cutoff. */
export const prunePendingCheckoutStages = (
  cutoffIso: string,
): Promise<number> =>
  discardPendingCheckoutsWhere("stage.created_at < ?", [cutoffIso]);
