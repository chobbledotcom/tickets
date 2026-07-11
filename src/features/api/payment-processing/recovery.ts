import { sessionSuccess } from "#routes/api/payment-processing/create.ts";
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
import { parseTokens } from "#routes/tickets/token-utils.ts";
import { queryOnePrimary } from "#shared/db/client.ts";
import {
  decryptSessionTokens,
  type ProcessedPayment,
  UNRESOLVED_RESERVATION,
} from "#shared/db/processed-payments.ts";

/** Recover an atomically finalized ticket after result handling throws. Refund
 * only when the primary reservation proves the booking never committed. */
export const recoverOrRefundUnexpectedCreate = async (
  session: ValidatedSession["session"],
  intent: BookingIntent,
  placeholders: ReturnType<typeof placeholderBookings>,
  error: unknown,
): Promise<PaymentResult> => {
  const finalized = await queryOnePrimary<{
    attendee_id: number;
    ticket_tokens: ProcessedPayment["ticket_tokens"];
  }>(
    `SELECT attendee_id, ticket_tokens FROM processed_payments
     WHERE payment_session_id = ? AND attendee_id IS NOT NULL AND ticket_tokens != ''`,
    [session.id],
  );
  if (finalized !== null) {
    const ticketTokens = parseTokens(
      await decryptSessionTokens(finalized.ticket_tokens),
    );
    return sessionSuccess(
      finalized.attendee_id,
      intent.items[0]!.e,
      ticketTokens,
    );
  }

  const unresolved = await queryOnePrimary<{ present: number }>(
    `SELECT 1 AS present FROM processed_payments
     WHERE payment_session_id = ? AND ${UNRESOLVED_RESERVATION}`,
    [session.id],
  );
  if (unresolved === null) throw error;

  return storeRefundedBooking(
    session,
    intent,
    placeholders,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${session.id}: ${String(error)}`,
    ),
  );
};
