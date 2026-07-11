/**
 * Payment processing - the shared payment state machine.
 *
 * A payment session moves through a small, fixed lifecycle:
 *
 *   unreserved → reserved → (finalized success | terminal failure)
 *
 * via validate → reserve → process → record-outcome.
 *
 * 1. validate  — `validatePaidSession` (classify.ts) confirms with the provider
 *    that the session is paid and `classifySession` proves (via a signed price
 *    proof) that the session is ours, yielding the `ValidatedSession` the rest of
 *    the machine runs on.
 * 2. reserve   — `processPaymentSession` claims the idempotency lock
 *    (`reserveSession`); a conflict replays the already-recorded outcome
 *    (`handleReservationConflict`) instead of re-processing.
 * 3. process   — `processReservedSession` creates a ticket, settles a balance,
 *    or stores and refunds a quantity-0 placeholder when the paid booking cannot
 *    be honoured before its atomic write commits.
 * 4. record-outcome — `processPaymentSession` records a handled failure as the
 *    session's terminal outcome (`markSessionFailed`) so a later redirect/webhook
 *    replays the same result, or releases the reservation when a real refund
 *    failed so the next provider redelivery re-attempts it.
 *
 */

import {
  alreadyProcessedResult,
  createAttendeeForSession,
  logPromoCodeModifiers,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import {
  checkoutIntentForSession,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  refundSpec,
  refuseMismatch,
} from "#routes/api/payment-processing/refunds.ts";
import {
  datelessGhostBookings,
  placeholderBookings,
  settleBalanceSession,
  specForFailure,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  BookingIntent,
  PaymentFailureResult,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { eventGroupHasLegs } from "#shared/accounting/queries.ts";
import { type PricedOrder, priceCheckout } from "#shared/checkout-pricing.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { queryOnePrimary } from "#shared/db/client.ts";
import { buyerVisits, specsFromRefs } from "#shared/db/modifier-resolve.ts";
import {
  finalizeSessionIfUnresolved,
  markSessionFailed,
  type ProcessedPayment,
  parseSessionFailure,
  releaseReservation,
  reserveSession,
  setSessionTicketTokens,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";
import { bookingLedgerDisposition } from "#shared/session-ledger.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";

type SessionProcessorOptions = { storeTokens?: boolean };

type SessionProcessor = (
  sessionId: string,
  data: ValidatedSession,
  options?: SessionProcessorOptions,
) => Promise<PaymentResult>;

const handleReservationConflict = async (
  intent: BookingIntent,
  existing: ProcessedPayment,
): Promise<PaymentResult> => {
  if (existing.attendee_id !== null) {
    return alreadyProcessedResult(intent.items[0]!.e, {
      ...existing,
      attendee_id: existing.attendee_id,
    });
  }
  // Replay an encrypted terminal outcome without revalidating or refunding.
  const failure = await parseSessionFailure(existing.failure_data);
  if (failure) return { ...failure, success: false };
  return {
    error: "Payment is being processed. Please wait a moment and refresh.",
    status: 409,
    success: false,
  };
};

/** Heal a fresh reservation from the ledger's attendee, preserving any tokens
 * finalized by a racing delivery. The recorded money is never refunded. */
type ReplaySuccessInput = {
  attendeeId: number;
  listingId: number;
  paymentReference: string;
  sessionId: string;
};

const replaySuccess = async ({
  attendeeId,
  listingId,
  paymentReference,
  sessionId,
}: ReplaySuccessInput): Promise<PaymentResult> => {
  await finalizeSessionIfUnresolved(sessionId, attendeeId, paymentReference);
  return sessionSuccess(attendeeId, listingId);
};

/** Acknowledge recorded money whose booking is gone without refunding again or
 * recreating it; its orphaned ledger rows remain for operator reconciliation. */
const alreadyHandledSession = (
  sessionId: string,
  listingId: number,
): PaymentFailureResult => ({
  detail: `Ledger already records session ${sessionId} with no live booking (listing ${listingId})`,
  error: "This payment has already been processed.",
  status: 200,
  success: false,
});

/** Resolve a booking against the durable ledger before any validation, pricing,
 * or refund path. This protects live tickets after their idempotency row is lost. */
const replaySessionFromLedger = async (
  sessionId: string,
  listingId: number,
  paymentReference: string,
): Promise<PaymentResult | false> => {
  const disposition = await bookingLedgerDisposition(sessionId);
  switch (disposition.status) {
    case "unrecorded":
      return false;
    case "booked":
      return replaySuccess({
        attendeeId: disposition.attendeeId,
        listingId,
        paymentReference,
        sessionId,
      });
    case "orphaned":
      return alreadyHandledSession(sessionId, listingId);
  }
};

/** Replay a balance payment already recorded by the ledger, or settle it fresh. */
const replayBalanceFromLedger = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  paymentReference: string,
): Promise<PaymentResult | null> =>
  (await eventGroupHasLegs(await balanceEventGroup(sessionId)))
    ? replaySuccess({ attendeeId, listingId, paymentReference, sessionId })
    : null;

/** Refund an unexpected create failure only while its primary reservation is
 * still unresolved. A finalized or ambiguous row may own a live ticket. */
const storeUnexpectedRefund = async (
  session: ValidatedSession["session"],
  intent: BookingIntent,
  placeholders: ReturnType<typeof placeholderBookings>,
  error: unknown,
): Promise<PaymentFailureResult> => {
  const unresolved = await queryOnePrimary<{ present: number }>(
    `SELECT 1 AS present FROM processed_payments
     WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [session.id],
  );
  if (unresolved === null) {
    throw error;
  }
  return storeRefundedBooking(
    session,
    intent,
    placeholders,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${session.id}: ${String(error)}`,
    ),
  );
};

/** Process a reserved session into a ticket or handled terminal outcome. Errors
 * after an atomic booking commit propagate rather than refunding a live ticket. */
const processReservedSession: SessionProcessor = async (
  sessionId,
  data,
  options,
) => {
  const { session, intent, verdict } = data;
  const signedListingId = intent.items[0]!.e;

  // Balance payment: settle the existing attendee rather than create one. A
  // mismatch can't be "stored" (the attendee already exists), so it refunds-and-
  // fails as before, idempotently inside the reservation.
  if (intent.balanceAttendeeId) {
    // Preflight: a balance session whose payment leg is already in the ledger is
    // a replay (its idempotency row was pruned or lost). Replay success rather
    // than re-settling — settleAttendeeBalance would find nothing owed and refund
    // a balance that's already paid.
    const replay = await replayBalanceFromLedger(
      sessionId,
      intent.balanceAttendeeId,
      signedListingId,
      session.paymentReference,
    );
    if (replay) return replay;
    if (verdict.verdict === "mismatch") {
      return refuseMismatch(session, verdict.agreed, signedListingId);
    }
    return settleBalanceSession(sessionId, session, intent);
  }

  // Preflight: the durable ledger is the source of truth for "already honoured".
  // Replay a session the ledger already records BEFORE any validation, pricing,
  // or refund path runs below — so a late delivery (after the prunable idempotency
  // row is gone) never refunds a live ticket via the deleted-listing, price-change,
  // inactive-listing, or capacity paths, nor double-books it.
  const replay = await replaySessionFromLedger(
    sessionId,
    signedListingId,
    session.paymentReference,
  );
  if (replay !== false) return replay;

  // Phase 2: Validate listings.
  const validated = await validateAllItems(session, intent);
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
  const visits = await buyerVisits(intent.email, intent.phone);
  const modifierSpecs = await specsFromRefs(intent.modifiers, { visits });
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
    return storeRefundedBooking(session, intent, placeholders, knownRefund);
  }

  // Otherwise try to honour it at the charged price. ANY failure keeps the
  // booking at quantity 0 and refunds rather than dropping a paid customer: a
  // structured sold-out/capacity/encryption result, OR an unexpected throw after
  // the charge (which would otherwise crash-loop the webhook over paid money).
  let honoured: Awaited<ReturnType<typeof createAttendeeForSession>>;
  try {
    honoured = await createAttendeeForSession(
      session,
      intent,
      validatedItems,
      pricingIntent,
      pricedOrder,
    );
  } catch (error) {
    // The atomic create may have committed before result handling or the client
    // threw. Recheck its reservation on the primary before moving money.
    return storeUnexpectedRefund(session, intent, placeholders, error);
  }
  if (!honoured.ok) {
    return storeRefundedBooking(
      session,
      intent,
      placeholders,
      specForFailure(honoured),
    );
  }

  // Success: a real ticket, finalized atomically in the creation transaction.
  const createdEntries = honoured.entries;
  await saveSessionAnswers(createdEntries, intent);
  const firstAttendee = createdEntries[0]!;
  const ticketToken = firstAttendee.attendee.ticket_token;

  // Persist the ticket token for webhook replay when the caller needs it.
  if (options?.storeTokens !== false) {
    await setSessionTicketTokens(sessionId, [ticketToken]);
  }

  const codeSpecs = modifierSpecs.filter((s) => s.trigger === "code");
  if (codeSpecs.length > 0) {
    await logPromoCodeModifiers(
      codeSpecs,
      pricedOrder.modifierApplications,
      firstAttendee.listing,
      firstAttendee.attendee.id,
    );
  }

  await logAndNotifyRegistration(createdEntries, intent.siteTokenIndex);

  return sessionSuccess(firstAttendee.attendee.id, firstAttendee.listing.id, [
    ticketToken,
  ]);
};

export const processPaymentSession: SessionProcessor = async (
  sessionId,
  data,
  options,
) => {
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);
  if (!reservation.reserved) {
    return handleReservationConflict(data.intent, reservation.existing);
  }

  const result = await processReservedSession(sessionId, data, options);

  // A refund of a real payment that FAILED must stay retryable, and the very
  // next provider redelivery should re-attempt it. Releasing the reservation
  // now (rather than leaving it held with no recorded outcome) is what makes
  // that happen: a held reservation would make the redelivery collide with the
  // lock and return 409 until the row goes stale (~5 min), gating refund
  // recovery on a local timer instead of provider redelivery. Releasing lets
  // the next delivery re-claim and re-refund immediately. This CANNOT
  // double-pay: every provider refunds the full charge amount and rejects a
  // refund that exceeds the already-refunded balance, and tryRefund treats an
  // already-refunded payment as success — so a redelivery after a refund that
  // actually went through (but reported failure) records success, not a second
  // payout.
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
