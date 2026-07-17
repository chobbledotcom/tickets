/**
 * Shared paid-payment state machine: validate, reserve, process, then record the
 * outcome. A valid payment becomes an atomically finalized ticket or balance
 * settlement. Expected booking failures become terminal stored refunds.
 *
 * An uncertain ticket create is resolved from primary payment and token state.
 * HTTP redirect and webhook handling lives in `webhooks.ts`.
 */

import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import { completePaidBooking } from "#routes/api/payment-processing/completion.ts";
import { createAttendeeForSession } from "#routes/api/payment-processing/create.ts";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import {
  checkoutIntentForSession,
  paidPricingRefund,
} from "#routes/api/payment-processing/pricing.ts";
import {
  recoverOrRefundUnexpectedCreate,
  recoverOrRefundUnexpectedProcessing,
} from "#routes/api/payment-processing/recovery.ts";
import {
  chargeMismatchSpec,
  deletedListingSpec,
  refundSpec,
  refuseMismatch,
} from "#routes/api/payment-processing/refunds.ts";
import {
  handleReservationConflict,
  replayBalanceFromLedger,
  replaySessionFromLedger,
} from "#routes/api/payment-processing/replay.ts";
import {
  refundStagedBooking,
  settleBalanceSession,
  specForFailure,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { type PricedOrder, priceCheckout } from "#shared/checkout-pricing.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { DatabaseBusyError } from "#shared/db/client.ts";
import { buyerVisits, specsFromRefs } from "#shared/db/modifier-resolve.ts";
import {
  releaseReservation,
  reserveSession,
} from "#shared/db/processed-payments.ts";

/** The shared shape of the two-phase session processors: reserve/process a paid
 * session by id, given its validated data, and resolve to a {@link
 * PaymentResult}. */
type SessionProcessor = (
  sessionId: string,
  data: ValidatedSession,
) => Promise<PaymentResult>;

const validateStagedItems = async (
  data: ValidatedSession,
): Promise<
  | {
      items: Extract<
        Awaited<ReturnType<typeof validateAllItems>>,
        { ok: true }
      >;
    }
  | { result: PaymentResult }
> => {
  const { intent, session } = data;
  const validated = await validateAllItems(session, intent);
  if (!("success" in validated)) return { items: validated };
  const spec =
    validated.status === 404
      ? deletedListingSpec(session)
      : {
          ...refundSpec("unexpected_error")(
            `Listing validation failed for session ${session.id}: ${validated.error}`,
          ),
          error: validated.error,
          status: validated.status,
        };
  return {
    result: await refundStagedBooking(session, intent.items[0]!.e, spec),
  };
};

/**
 * Process a session we have just reserved (holding the lock). A signed session
 * either becomes a real ticket or — for ANY reason we can't honour it (charge
 * mismatch, a price edited mid-checkout, a sold-out extra, a full event, a
 * since-deleted listing, or an unexpected error after the charge) — is refunded.
 * Successful staged refunds store replay data atomically with cleanup.
 */
const processReservedSession: SessionProcessor = async (sessionId, data) => {
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
  if (replay) return replay;

  const stage = await loadCheckoutStageByPaymentSession(sessionId);
  if (!stage) {
    throw new Error(
      `Paid session ${sessionId} has no compatible checkout stage`,
    );
  }
  if (stage.state === "refunding") {
    return refundStagedBooking(
      session,
      signedListingId,
      refundSpec("unexpected_error")(
        `Continuing refund for session ${sessionId}`,
      ),
    );
  }

  // Phase 2: Validate listings.
  const validation = await validateStagedItems(data);
  if ("result" in validation) return validation.result;
  const validatedItems = validation.items.items;

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
  // A signed-by-us payment we already know we can't honour at the charged amount
  // or whose listing/modifier/answer price changed is refunded.
  const knownRefund =
    verdict.verdict === "mismatch"
      ? chargeMismatchSpec(session, verdict.agreed)
      : paidPricingRefund(validatedItems, pricedOrder, verdict.agreed);
  if (knownRefund) {
    return refundStagedBooking(session, signedListingId, knownRefund);
  }

  // Otherwise try to honour it at the charged price. An uncertain atomic result
  // is checked on the primary and refunded only when state proves rollback.
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
    );
  const honoured = await createAttendeeForSession(
    session,
    intent,
    validatedItems,
    pricingIntent,
    pricedOrder,
    stage,
  );
  if (honoured.ok === null) {
    return recoverOrRefundUnexpectedCreate({
      complete,
      error: honoured.error,
      intent,
      session,
      ticketToken: stage.ticketToken,
      validatedItems,
    });
  }
  if (!honoured.ok) {
    return refundStagedBooking(
      session,
      signedListingId,
      specForFailure(honoured),
    );
  }

  // Success: a real ticket, finalized atomically in the creation transaction.
  const createdEntries = await committedEntries(
    stage.attendeeId,
    stage.ticketToken,
    session,
    intent,
    validatedItems,
  );
  return complete(createdEntries, [stage.ticketToken]);
};

const processClaimedSession =
  (busyRetries: number): SessionProcessor =>
  async (sessionId, data) => {
    try {
      return await processReservedSession(sessionId, data);
    } catch (error) {
      if (error instanceof DatabaseBusyError) {
        if (busyRetries === 0) throw error;
        return processClaimedSession(busyRetries - 1)(sessionId, data);
      }
      return recoverOrRefundUnexpectedProcessing(sessionId, data, error);
    }
  };

const processPaymentSessionAttempt = async (
  sessionId: string,
  data: ValidatedSession,
  busyRetries: number,
): Promise<PaymentResult> => {
  // Phase 1: Reserve the session (claim the lock)
  const reservation = await reserveSession(sessionId);
  if (!reservation.reserved) {
    return handleReservationConflict(data.intent, reservation.existing);
  }

  let result: PaymentResult;
  try {
    result = await processClaimedSession(busyRetries)(sessionId, data);
  } catch (error) {
    await releaseReservation(sessionId);
    throw error;
  }

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

  return result;
};

export const processPaymentSession: SessionProcessor = (sessionId, data) =>
  processPaymentSessionAttempt(sessionId, data, 2);

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
