import { decideUnexpectedCreate } from "#routes/api/payment-processing/recovery-decision.ts";
import { refundSpec } from "#routes/api/payment-processing/refunds.ts";
import {
  type placeholderBookings,
  storeRefundedBooking,
} from "#routes/api/payment-processing/store-refund.ts";
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { queryBatchPrimary, resultRows } from "#shared/db/client.ts";

type UnexpectedCreateRecovery = {
  complete: (
    attendeeId: number,
    ticketTokens: string[],
  ) => Promise<PaymentResult>;
  error: unknown;
  placeholders: ReturnType<typeof placeholderBookings>;
  work: PaymentWork;
  ticketToken: string;
};

const loadRecoveryFacts = async (
  work: PaymentWork,
  ticketTokenIndex: BlindIndex,
) => {
  const { claim, payment } = work;
  const [paymentResult, unresolvedResult, attendeeResult] =
    await queryBatchPrimary([
      {
        args: [payment.id, ticketTokenIndex],
        sql: `SELECT paymentSession.attendee_id
              FROM payment_sessions AS paymentSession
              JOIN attendees AS attendee
                ON attendee.id = paymentSession.attendee_id
              WHERE paymentSession.id = ?
                AND attendee.ticket_token_index = ?`,
      },
      {
        args: [payment.id, claim.leaseToken, claim.revision],
        sql: `SELECT 1 AS present FROM payment_sessions
              WHERE id = ? AND lease_token = ? AND revision = ?
                AND attendee_id IS NULL`,
      },
      {
        args: [ticketTokenIndex],
        sql: "SELECT id FROM attendees WHERE ticket_token_index = ?",
      },
    ]);
  const attached = resultRows<{ attendee_id: number }>(paymentResult!)[0];
  const attendee = resultRows<{ id: number }>(attendeeResult!)[0];
  return {
    finalizedAttendeeId:
      attached === undefined ? null : Number(attached.attendee_id),
    tokenAttendeeId: attendee === undefined ? null : Number(attendee.id),
    unresolved: resultRows<{ present: number }>(unresolvedResult!).length === 1,
  };
};

/** Resolve an uncertain atomic create from primary state. Refund only when the
 * unresolved reservation and missing prepared token prove the batch rolled back. */
export const recoverOrRefundUnexpectedCreate = async ({
  complete,
  error,
  placeholders,
  work,
  ticketToken,
}: UnexpectedCreateRecovery): Promise<PaymentResult> => {
  const decision = decideUnexpectedCreate(
    await loadRecoveryFacts(work, await hmacHash(ticketToken)),
  );
  if (decision.kind === "recover") {
    return complete(decision.attendeeId, [ticketToken]);
  }
  if (decision.kind === "rethrow") throw error;
  return storeRefundedBooking(
    work,
    placeholders,
    refundSpec("unexpected_error")(
      `Unexpected error completing session ${work.payment.id}: ${String(error)}`,
    ),
  );
};
