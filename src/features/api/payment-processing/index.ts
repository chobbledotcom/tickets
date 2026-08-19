/**
 * Shared paid-payment state machine: validate, reserve, process, then record the
 * outcome. A valid payment becomes an atomically finalized ticket or balance
 * settlement. Expected booking failures become terminal stored refunds.
 *
 * An uncertain ticket create is resolved from primary payment and token state.
 * HTTP redirect and webhook handling lives in `webhooks.ts`.
 */

import { eventGroupHasLegs } from "#accounting/queries.ts";
import { generateTicketToken } from "#crypto/utils.ts";
import { balanceEventGroup } from "#db/attendees/balance.ts";
import {
  finalizeSessionIfUnresolved,
  markSessionFailed,
  type ProcessedPayment,
  parseSessionFailure,
  releaseReservation,
  reserveSession,
} from "#db/processed-payments.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { sessionAnswerOf } from "#payment/row-state.ts";
import { paymentReferenceOf } from "#payment/validated-session.ts";
import { completePaidBooking } from "#routes/api/payment-processing/completion.ts";
import {
  alreadyProcessedResult,
  createAttendeeForSession,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { resumePlaceholderSession } from "#routes/api/payment-processing/placeholder-resume.ts";
import {
  checkoutIntentForSession,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import { recoverOrRefundUnexpectedCreate } from "#routes/api/payment-processing/recovery.ts";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  refuseMismatch,
} from "#routes/api/payment-processing/refunds.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import {
  datelessGhostBookings,
  placeholderBookings,
  settleBalanceSession,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { type PricedOrder, priceCheckout } from "#shared/checkout-pricing.ts";
import { logDebug } from "#shared/logger.ts";
import type { BookingLedgerDisposition } from "#shared/session-ledger.ts";

/** The shared shape of the two-phase session processors: reserve/process a paid
 * session by id, given its validated data, and resolve to a {@link
 * PaymentResult}. */
type SessionProcessor = (
  sessionId: string,
  data: ValidatedSession,
) => Promise<PaymentResult>;

/** Handle the "already reserved" branch of reserveSession */
const handleReservationConflict = async (
  data: ValidatedSession,
  existing: ProcessedPayment,
): Promise<PaymentResult> => {
  if (existing.attendee_id !== null) {
    return alreadyProcessedResult(data.intent.items[0]!.e, {
      ...existing,
      attendee_id: existing.attendee_id,
    });
  }
  // A recorded terminal failure replays the same handled outcome (refund
  // already issued, sold out, price changed) without re-validating or
  // re-refunding. failure_data is encrypted, so this read is async.
  const failure = await parseSessionFailure(existing.failure_data);
  if (failure) {
    // A completion marker says the placeholder may still owe money records:
    // finish them before answering, so a crashed first delivery cannot park
    // the books. Unmarked failures replay with no extra reads.
    const resumed = await resumePlaceholderSession(data, failure);
    if (resumed) return resumed;
    return { ...sessionAnswerOf(failure), success: false };
  }
  // Otherwise reserved but not finalized — another request is mid-flight.
  return {
    error: "Payment is being processed. Please wait a moment and refresh.",
    status: 409,
    success: false,
  };
};

/**
 * Replay a payment session the ledger already records as resolved to
 * `attendeeId`: heal the fresh reservation at that attendee — token-safely, so a
 * racing delivery's finalized tokens survive (see {@link
 * finalizeSessionIfUnresolved}) — and return success. NEVER refunds: the money is
 * already in the ledger against this attendee. Tokens come back empty, so the
 * redirect renders directly from the attendee. Shared by the booking-replay and
 * balance-replay preflights.
 */
const replaySuccess = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  paymentReference: TaggedPaymentReference | null,
): Promise<PaymentResult> => {
  await finalizeSessionIfUnresolved(sessionId, attendeeId, paymentReference);
  logDebug("Payment", `Replayed already-ledgered session ${sessionId}`);
  return sessionSuccess(attendeeId, listingId);
};

/**
 * Acknowledge a session the ledger already accounts for but whose booking is
 * gone — an operator deleted the attendee (its sale/payment legs remain) or it
 * was a refunded quantity-0 placeholder. The money is already recorded, so we
 * neither refund again nor recreate the booking: return a terminal handled
 * outcome (200 — the webhook acks it, the redirect shows it as processed) and
 * leave the orphaned ledger rows for the operator to reconcile.
 */
const alreadyHandledSession = (
  sessionId: string,
  listingId: number,
): PaymentFailureResult => ({
  detail: `Ledger already records session ${sessionId} with no live booking (listing ${listingId})`,
  error: "This payment has already been processed.",
  status: 200,
  success: false,
});

/**
 * The booking-session ledger preflight: the durable ledger — not the prunable
 * processed_payments row — is the source of truth for "already honoured", so
 * before validating, pricing, or refunding, resolve what it already records.
 * Returns the replay outcome for a session it has seen (a live booking replays as
 * success; an orphaned one is acknowledged), or null for a session it has never
 * recorded (process it fresh). The single guard that stops a late replay — after
 * the idempotency row is pruned or lost to a stale-reservation cleanup — from
 * refunding a live ticket via the deleted-listing, price-change, inactive-listing,
 * or capacity refund paths below.
 */
const replaySessionFromLedger = async (
  sessionId: string,
  listingId: number,
  paymentReference: TaggedPaymentReference | null,
  disposition: BookingLedgerDisposition,
): Promise<PaymentResult | null> => {
  switch (disposition.status) {
    case "unrecorded":
      return null;
    case "booked":
      return replaySuccess(
        sessionId,
        disposition.attendeeId,
        listingId,
        paymentReference,
      );
    case "orphaned":
      return alreadyHandledSession(sessionId, listingId);
  }
};

const processNewBookingSession = async (
  sessionId: string,
  data: ValidatedSession,
  signedListingId: number,
): Promise<PaymentResult> => {
  const { session, intent, verdict } = data;
  const snapshot = await loadPaidOrderSnapshot(sessionId, intent);

  // Preflight: the durable ledger is the source of truth for "already honoured".
  // Replay a session the ledger already records BEFORE any validation, pricing,
  // or refund path runs below — so a late delivery (after the prunable idempotency
  // row is gone) never refunds a live ticket via the deleted-listing, price-change,
  // inactive-listing, or capacity paths, nor double-books it.
  const replay = await replaySessionFromLedger(
    sessionId,
    signedListingId,
    paymentReferenceOf(session),
    snapshot.ledger,
  );
  if (replay) return replay;

  // Phase 2: Validate listings.
  const validated = await validateAllItems(session, intent, snapshot);
  if ("success" in validated) {
    // A trusted session (we signed it) whose listing was deleted between checkout
    // and payment. listing_attendees has no FK to listings, so we still keep a
    // quantity-0 ghost per SIGNED LINE — the deleted listing may sit anywhere in
    // a multi-item cart, and the operator record must name every line (with its
    // package path) rather than collapse onto the first item's listing. Ghosts
    // are dateless: the deleted line's listing row is gone, so there is nothing
    // to derive date fields from. A foreign instance's 404 (signed by someone
    // else) never reaches here.
    if (validated.status === 404) {
      return storeRefundedBooking(
        session,
        intent,
        datelessGhostBookings(intent.items),
        deletedListingSpec(session),
        snapshot.publicStatusId,
      );
    }
    return validated;
  }
  const validatedItems = validated.items;

  // Resolve the applied modifiers once (re-fetched by id from the database);
  // both the price re-derivation and the stock consumption use the same specs.
  // Every trigger — automatic, code, opt-in add-on, and answer — rides the same
  // metadata refs and is re-fetched by id here, re-checking the visit gate and
  // re-deriving the amount so a tampered checkout can't dodge a surcharge.
  const modifierSpecs = snapshot.modifierSpecs;
  const pricingIntent = checkoutIntentForSession(
    intent,
    validatedItems,
    modifierSpecs,
  );
  const pricedOrder: PricedOrder = priceCheckout(pricingIntent);
  const placeholders = placeholderBookings(validatedItems, intent);

  // A signed-by-us payment we already know we can't honour at the charged amount
  // — the provider charged a different total, or a listing/modifier/answer price
  // was edited between checkout and now: keep it as a quantity-0 placeholder and
  // refund, never drop it.
  const knownRefund =
    verdict.verdict === "mismatch"
      ? chargeMismatchSpec(session, verdict.agreed)
      : paidPricingRefund(validatedItems, pricedOrder, verdict.agreed);
  if (knownRefund) {
    return storeRefundedBooking(
      session,
      intent,
      placeholders,
      knownRefund,
      snapshot.publicStatusId,
    );
  }

  // Otherwise try to honour it at the charged price. Expected refusal keeps a
  // quantity-0 placeholder. An uncertain atomic result is checked on the primary
  // and refunded only when committed state proves that the batch rolled back.
  const ticketToken = generateTicketToken();
  const codeSpecs = modifierSpecs.filter((spec) => spec.trigger === "code");
  const complete = (
    entries: Parameters<typeof completePaidBooking>[0],
    ticketTokens: string[],
  ) =>
    completePaidBooking(
      entries,
      intent,
      codeSpecs,
      pricedOrder.modifierApplications,
      ticketTokens,
      snapshot.notificationPackages,
    );
  const honoured = await createAttendeeForSession(
    session,
    intent,
    validatedItems,
    pricingIntent,
    pricedOrder,
    ticketToken,
    snapshot.publicStatusId,
    snapshot.parentsByChildId,
  );
  if (honoured.ok === null) {
    return recoverOrRefundUnexpectedCreate({
      complete,
      error: honoured.error,
      intent,
      placeholders,
      publicStatusId: snapshot.publicStatusId,
      session,
      ticketToken,
      validatedItems,
    });
  }
  if (!honoured.ok) {
    return storeRefundedBooking(
      session,
      intent,
      placeholders,
      specForFailure(honoured),
      snapshot.publicStatusId,
    );
  }

  // Success: a real ticket, finalized atomically in the creation transaction.
  const createdEntries = honoured.entries;
  const firstAttendee = createdEntries[0]!;
  return complete(createdEntries, [firstAttendee.attendee.ticket_token]);
};

/**
 * Process a session we have just reserved (holding the lock). A signed session
 * either becomes a real ticket or — for ANY reason we can't honour it (charge
 * mismatch, a price edited mid-checkout, a sold-out extra, a full event, a
 * since-deleted listing, or an unexpected error after the charge) — is kept as a
 * quantity-0 placeholder and refunded, so a paid customer is never dropped. Every
 * failure returned here is a handled terminal outcome; processPaymentSession
 * records it so a later redirect/webhook replays the same result instead of
 * re-running refunds or stalling behind the idempotency lock.
 */
const processReservedSession: SessionProcessor = async (sessionId, data) => {
  const { session, intent, verdict } = data;
  const signedListingId = intent.items[0]!.e;
  if (intent.balanceAttendeeId) {
    // A balance session whose payment leg is already in the ledger is a replay
    // even if its idempotency row was pruned or lost. Settling it again would
    // find nothing owed and refund a balance that is already paid.
    if (await eventGroupHasLegs(await balanceEventGroup(sessionId))) {
      return replaySuccess(
        sessionId,
        intent.balanceAttendeeId,
        signedListingId,
        paymentReferenceOf(session),
      );
    }
    if (verdict.verdict === "mismatch") {
      return refuseMismatch(session, verdict.agreed, signedListingId);
    }
    return settleBalanceSession(sessionId, session, intent);
  }
  return processNewBookingSession(sessionId, data, signedListingId);
};

export const processPaymentSession: SessionProcessor = async (
  sessionId,
  data,
) => {
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);
  if (!reservation.reserved) {
    return handleReservationConflict(data, reservation.existing);
  }

  const result = await processReservedSession(sessionId, data);

  // Keep a failed refund callback retryable. The durable refund authority, not
  // this short booking reservation, decides whether a later delivery may send,
  // observe, or wait for the owner, so releasing cannot create a second send.
  if (!result.success && result.refunded === false) {
    await releaseReservation(sessionId);
    return result;
  }

  // Otherwise record a handled failure as the session's terminal outcome so a
  // later redirect/webhook for the same paid session replays it (same message
  // and refund status) instead of re-refunding or stalling behind the lock. The
  // transient "another request is processing" conflict returns above and never
  // reaches here, so it stays retryable too.
  if (!result.success) {
    await markSessionFailed(sessionId, {
      error: result.error,
      refunded: result.refunded,
      status: result.status,
    });
  }

  return result;
};

/**
 * Format error message based on refund status
 */
export const formatPaymentError = (result: PaymentFailureResult): string => {
  if (result.refunded === true) {
    return `${result.error} Your payment has been automatically refunded.`;
  }
  if (result.refunded === false) {
    return `${result.error} Please contact support for a refund.`;
  }
  return result.error;
};
