import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { decideUnexpectedCreate } from "#routes/api/payment-processing/recovery-decision.ts";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import {
  type placeholderBookings,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { queryBatchPrimary, resultRows } from "#shared/db/client.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

type UnexpectedCreateRecovery = {
  complete: (
    entries: CreatedEntry[],
    ticketTokens: string[],
  ) => Promise<PaymentResult>;
  error: unknown;
  intent: BookingIntent;
  placeholders: ReturnType<typeof placeholderBookings>;
  publicStatusId: number;
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

/** Resolve an uncertain atomic create from primary state. Refund only when the
 * unresolved reservation and missing prepared token prove the batch rolled back. */
export const recoverOrRefundUnexpectedCreate = async ({
  complete,
  error,
  intent,
  placeholders,
  publicStatusId,
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
    return complete(entries, [ticketToken]);
  }
  if (decision.kind === "rethrow") throw error;
  return storeRefundedBooking(
    session,
    intent,
    placeholders,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${session.id}: ${String(error)}`,
    ),
    publicStatusId,
  );
};
