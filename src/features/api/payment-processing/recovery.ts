import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import { refundStagedBooking } from "#routes/api/payment-processing/store-refund.ts";
import type {
  BookingIntent,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { queryBatchPrimary, resultRows } from "#shared/db/client.ts";
import {
  releaseReservation,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";

type UnexpectedCreateRecovery = {
  complete: (
    entries: CreatedEntry[],
    ticketTokens: string[],
  ) => Promise<PaymentResult>;
  error: unknown;
  intent: BookingIntent;
  session: ValidatedSession["session"];
  ticketToken: string;
  validatedItems: ValidatedItem[];
};

const loadRecoveryFacts = async (sessionId: string) => {
  const [paymentResult, unresolvedResult, stageResult] =
    await queryBatchPrimary([
      {
        args: [sessionId],
        sql: `SELECT attendee_id FROM processed_payments
              WHERE payment_session_id = ? AND attendee_id IS NOT NULL`,
      },
      {
        args: [sessionId],
        sql: `SELECT 1 AS present FROM processed_payments
              WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
      },
      {
        args: [sessionId],
        sql: `SELECT attendee_id, state FROM checkout_stages
              WHERE payment_session_id = ?`,
      },
    ]);
  const payment = resultRows<{ attendee_id: number }>(paymentResult!)[0];
  const stage = resultRows<{ attendee_id: number; state: string }>(
    stageResult!,
  )[0];
  return {
    finalizedAttendeeId:
      payment === undefined ? null : Number(payment.attendee_id),
    stage,
    unresolved: resultRows<{ present: number }>(unresolvedResult!).length === 1,
  };
};

/** Resolve an uncertain atomic create from primary state. Refund only when the
 * unresolved reservation and missing prepared token prove the batch rolled back. */
export const recoverOrRefundUnexpectedCreate = async ({
  complete,
  error,
  intent,
  session,
  ticketToken,
  validatedItems,
}: UnexpectedCreateRecovery): Promise<PaymentResult> => {
  const facts = await loadRecoveryFacts(session.id);
  if (facts.finalizedAttendeeId !== null) {
    const entries = await committedEntries(
      facts.finalizedAttendeeId,
      ticketToken,
      session,
      intent,
      validatedItems,
    );
    return complete(entries, [ticketToken]);
  }
  if (!facts.unresolved || facts.stage === undefined) throw error;
  return refundStagedBooking(
    session,
    intent.items[0]!.e,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${session.id}: ${String(error)}`,
    ),
  );
};

/** Refund an ordinary staged booking after an unexpected processing error.
 * Balance payments and sessions without an open stage preserve the original
 * error because there is no staged attendee to refund and remove. */
export const recoverOrRefundUnexpectedProcessing = async (
  sessionId: string,
  data: ValidatedSession,
  error: unknown,
): Promise<PaymentResult> => {
  if (data.intent.balanceAttendeeId) throw error;
  const stage = await loadCheckoutStageByPaymentSession(sessionId);
  if (!stage) throw error;
  if (stage.state === "refunding") {
    await releaseReservation(sessionId);
    throw error;
  }
  try {
    return await refundStagedBooking(
      data.session,
      data.intent.items[0]!.e,
      refundSpec("unexpected_error")(
        `Unexpected error completing session ${sessionId}: ${String(error)}`,
      ),
    );
  } catch (refundError) {
    await releaseReservation(sessionId);
    throw refundError;
  }
};
