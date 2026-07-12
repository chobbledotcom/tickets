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
  BookingIntent,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { queryBatchPrimary, resultRows } from "#shared/db/client.ts";
import { recordOrderActivity } from "#shared/db/contact-tokens.ts";
import { UNRESOLVED_RESERVATION } from "#shared/db/processed-payments.ts";

type UnexpectedCreateRecovery = {
  complete: (
    entries: CreatedEntry[],
    ticketTokens: string[],
  ) => Promise<PaymentResult>;
  error: unknown;
  intent: BookingIntent;
  placeholders: ReturnType<typeof placeholderBookings>;
  session: ValidatedSession["session"];
  ticketToken: string;
  validatedItems: ValidatedItem[];
};

/** Restore the contact history normally written after the booking batch returns.
 * A committed batch whose result was lost never reached that completion step. */
const recordRecoveredOrderActivity = (
  intent: BookingIntent,
  ticketToken: string,
): Promise<void> =>
  recordOrderActivity(intent.email, intent.phone, "public", ticketToken);

const loadRecoveryFacts = async (
  sessionId: string,
  ticketTokenIndex: BlindIndex,
) => {
  const [finalizedResult, unresolvedResult, attendeeResult] =
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
  const finalized = resultRows<{ attendee_id: number }>(finalizedResult!)[0];
  const attendee = resultRows<{ id: number }>(attendeeResult!)[0];
  return {
    finalizedAttendeeId: finalized === undefined ? null : finalized.attendee_id,
    tokenAttendeeId: attendee === undefined ? null : attendee.id,
    unresolved: resultRows<{ present: number }>(unresolvedResult!).length === 1,
  };
};

/** Recover an atomically finalized ticket after result handling throws. Refund
 * only when the primary reservation proves the booking never committed. */
export const recoverOrRefundUnexpectedCreate = async ({
  complete,
  error,
  intent,
  placeholders,
  session,
  ticketToken,
  validatedItems,
}: UnexpectedCreateRecovery): Promise<PaymentResult> => {
  const ticketTokenIndex = await computeTicketTokenIndex(ticketToken);
  const decision = decideUnexpectedCreate(
    await loadRecoveryFacts(session.id, ticketTokenIndex),
  );
  if (decision.kind === "recover") {
    const entries = await committedEntries(
      decision.attendeeId,
      ticketToken,
      session,
      intent,
      validatedItems,
    );
    await recordRecoveredOrderActivity(intent, ticketToken);
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
  );
};
