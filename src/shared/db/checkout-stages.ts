/* jscpd:ignore-start */
import * as v from "valibot";
import { unique } from "#fp";
import { t } from "#i18n";
import {
  type CanonicalBooking,
  orderBookingsFor,
  signedPaidLine,
} from "#shared/booking-lines.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import type { CreateAttendeeSuccess } from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#shared/db/attendees/api.ts";
import { bookingCapacityFields } from "#shared/db/attendees/capacity/checks.ts";
import {
  type CheckoutStageState,
  CheckoutStageStateSchema,
  isOpenCheckoutStage,
  OPEN_CHECKOUT_STAGE_SQL,
} from "#shared/db/checkout-stage-state.ts";
import {
  execute,
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

type TerminalCheckoutStageState = Extract<
  CheckoutStageState,
  "booked" | "failed"
>;

/** The order's real-quantity bookings from the signed intent — the single
 * source both the availability preflight and the quantity-0 staging derive
 * from, so what we check is exactly what we stage. */
const orderedBookings = async (
  intent: CheckoutIntent,
): Promise<CanonicalBooking[]> => {
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
  return orderBookingsFor(
    intent,
    lines.map(({ item, listing }) => signedPaidLine(item, listing)),
  );
};

const stagedBookings = async (
  intent: CheckoutIntent,
): Promise<CanonicalBooking[]> =>
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
    bookings.map(bookingCapacityFields),
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
  // An OPEN stage whose attendee is gone is an IMPOSSIBLE state: every
  // deletion path removes the stage with the attendee (deleteAttendee cascades
  // it; the prune deletes both), admin edits/merges/deletes are blocked while
  // open, and a listing can't be deleted while it has an open checkout. So
  // a dangling open stage means a delete skipped the stage cascade — surface
  // the bug, don't silently book fresh around it. (A RESOLVED (booked/failed)
  // dangling stage is returned as-is, so the resolved-stage guard still refuses
  // to re-process money already handled.)
  if (row.attendee_exists === null && isOpenCheckoutStage(parsedState)) {
    throw new Error(
      `Checkout stage for session ${sessionId} points at deleted attendee ${row.attendee_id} while still open — an open stage must never outlive its attendee`,
    );
  }
  // Terminal rows survive briefly as replay guards, but no longer need the
  // bearer credential. Return their state without decrypting an empty field.
  if (!isOpenCheckoutStage(parsedState)) {
    return {
      attendeeId: row.attendee_id,
      state: parsedState,
      ticketToken: "",
    };
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
 * Which of these attendees are mid-payment: the customer may still be paying,
 * or a paid order is finishing its refund. Admin mutations (edits, merges,
 * deletes) must leave either state alone. Array in, set out — call with one id
 * for the single case.
 */
// Pinned to the primary: this gates mutations, and a replica lagging the
// just-staged insert would let an edit slip through the guard.
export const attendeeIdsWithPendingStage = primaryMatchingIdSet(
  (placeholders) =>
    `SELECT attendee_id AS id FROM checkout_stages
      WHERE state ${OPEN_CHECKOUT_STAGE_SQL}
        AND attendee_id IN (${placeholders})`,
);

/** Does this listing have any attendee mid-payment (an open staged checkout)?
 * Gates listing deletion: deleting a listing removes its booking rows but leaves
 * the attendee behind, which would strand an open stage's payment (its rows
 * vanish, so the claim can never land). Primary-pinned, like the mutation guard
 * above — a replica lagging a just-staged insert must not let the delete slip. */
export const listingHasPendingCheckout = async (
  listingId: number,
): Promise<boolean> =>
  (await queryOnePrimary<{ one: number }>(
    `SELECT 1 AS one
       FROM checkout_stages AS stage
       JOIN listing_attendees AS booking ON booking.attendee_id = stage.attendee_id
       WHERE stage.state ${OPEN_CHECKOUT_STAGE_SQL} AND booking.listing_id = ?
      LIMIT 1`,
    [listingId],
  )) !== null;

/** Whether this one attendee is mid-payment — an open staged checkout the
 * payment may still claim or refund. Single-id form of {@link attendeeIdsWithPendingStage}
 * for the admin-edit guards that block a save while the payment is in flight. */
export const hasPendingCheckout = async (
  attendeeId: number,
): Promise<boolean> =>
  (await attendeeIdsWithPendingStage([attendeeId])).has(attendeeId);

export const markCheckoutStage = async (
  sessionId: string,
  state: TerminalCheckoutStageState = "failed",
): Promise<void> => {
  await execute(
    "UPDATE checkout_stages SET state = ?, ticket_tokens = '' WHERE payment_session_id = ?",
    [state, sessionId],
  );
};

/** Permanently route a paid stage away from activation before asking the
 * provider for a refund. A retry may continue refunding, but can never book. */
export const beginCheckoutStageRefund = async (
  sessionId: string,
): Promise<void> => {
  const result = await execute(
    `UPDATE checkout_stages SET state = 'refunding'
      WHERE payment_session_id = ? AND state = 'pending'`,
    [sessionId],
  );
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Checkout stage for session ${sessionId} did not enter refunding`,
    );
  }
};

/** Resolve a stage a crash left open after its money was already recorded.
 * Guarded to open states so a booked stage is never downgraded, and a session with
 * no stage is a no-op. Called when the ledger preflight answers "already
 * handled": the outcome is known, so the record must not read as mid-payment
 * forever — an open stage blocks edits and merges and holds the staged
 * details unprunable. */
export const resolvePendingStage = async (sessionId: string): Promise<void> => {
  await execute(
    `UPDATE checkout_stages SET state = 'failed', ticket_tokens = ''
      WHERE payment_session_id = ? AND state ${OPEN_CHECKOUT_STAGE_SQL}`,
    [sessionId],
  );
};

/** Heal an open stage from the attendee that already owns the durable payment
 * outcome. The staged attendee was booked only when it is that same owner; a
 * different owner means rollback-era code booked a second attendee, so the
 * untouched quantity-zero stage failed. Neither case moves bookings or money. */
export const resolveOpenStageFromOwner = async (
  sessionId: string,
  ownerAttendeeId: number,
): Promise<void> => {
  await execute(
    `UPDATE checkout_stages
        SET state = CASE WHEN attendee_id = ? THEN 'booked' ELSE 'failed' END,
            ticket_tokens = ''
      WHERE payment_session_id = ? AND state ${OPEN_CHECKOUT_STAGE_SQL}`,
    [ownerAttendeeId, sessionId],
  );
};
