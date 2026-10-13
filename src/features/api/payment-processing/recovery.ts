import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { queryBatchPrimary, resultRows } from "#db/client.ts";
import {
  releaseReservation,
  UNRESOLVED_RESERVATION,
} from "#db/processed-payments.ts";
import { sessionSuccess } from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { decideUnexpectedCreate } from "#routes/api/payment-processing/recovery-decision.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { queueRegistrationSends } from "#shared/webhook/delivery.ts";
import { committedEntries } from "./committed-entries.ts";

type UnexpectedCreateRecovery = {
  error: unknown;
  intent: BookingIntent;
  listingId: number;
  session: ValidatedSession["session"];
  ticketToken: string;
  validatedItems: ValidatedItem[];
};

const loadRecoveryFacts = async (
  sessionId: string,
  ticketTokenIndex: BlindIndex,
) => {
  const [paymentResult, unresolvedResult, attendeeResult] =
    await queryBatchPrimary([
      {
        args: [sessionId, ticketTokenIndex],
        sql: `SELECT processedPayment.attendee_id
              FROM processed_payments AS processedPayment
              JOIN attendees AS attendee
                ON attendee.id = processedPayment.attendee_id
              WHERE processedPayment.payment_session_id = ?
                AND attendee.ticket_token_index = ?`,
      },
      {
        args: [sessionId],
        sql: `SELECT 1 AS present FROM processed_payments
              WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
      },
      {
        args: [ticketTokenIndex],
        sql: "SELECT id FROM attendees WHERE ticket_token_index = ?",
      },
    ]);
  const payment = resultRows<{ attendee_id: number }>(paymentResult!)[0];
  const attendee = resultRows<{ id: number }>(attendeeResult!)[0];
  return {
    finalizedAttendeeId:
      payment === undefined ? null : Number(payment.attendee_id),
    tokenAttendeeId: attendee === undefined ? null : Number(attendee.id),
    unresolved: resultRows<{ present: number }>(unresolvedResult!).length === 1,
  };
};

/**
 * Resolve an uncertain atomic create from primary state.
 *
 * A create batch carries the booking's whole completion (its answers, its
 * activity lines, and its pending-notification flags). A proven-committed
 * booking owes its external sends exactly once. The batch committed them,
 * but the lost result means nothing queued them. The recovery then reads the
 * committed entries and queues the sends. This arm runs in the one request
 * that lost the result. A later redelivery finds the finalized session and
 * answers send-free. A batch that provably rolled back released nothing into
 * the world. Release the session's reservation so the redelivery starts
 * fresh. Answer 500 so the provider tries the whole booking again. Anything
 * else is too unclear to answer — rethrow, and the 500 keeps the provider
 * retrying while the state settles.
 */
export const recoverOrRefundUnexpectedCreate = async ({
  error,
  intent,
  listingId,
  session,
  ticketToken,
  validatedItems,
}: UnexpectedCreateRecovery): Promise<PaymentResult> => {
  const decision = decideUnexpectedCreate(
    await loadRecoveryFacts(session.id, await hmacHash(ticketToken)),
  );
  if (decision.kind === "recover") {
    const entries = await committedEntries(
      decision.attendeeId,
      ticketToken,
      session,
      intent,
      validatedItems,
    );
    // The staged free-text rows went back inside the committed batch. The
    // strings table seals the buyer's typed words, so no notification can
    // spend them. The recovered sends render choice answers only. Say so
    // loudly when the booking carried typed answers, then queue the sends —
    // a booking with no queued confirmation is the louder wrong.
    const carriedTextAnswers = Object.values(
      intent.listingTextAnswerIds ?? {},
    ).some((refs) => refs.length > 0);
    if (carriedTextAnswers) {
      await logError({
        code: ErrorCode.DATA_INVALID,
        detail: `A recovered paid checkout answers from committed state, so its emails show choice answers only (session index ${await hmacHash(session.id)})`,
      });
    }
    await queueRegistrationSends(entries, { source: "public" });
    return sessionSuccess(decision.attendeeId, listingId);
  }
  if (decision.kind === "retry") {
    await releaseReservation(session.id);
  }
  throw error;
};
