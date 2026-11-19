import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { attendeeIdOfToken } from "#db/attendees/reads.ts";
import {
  releaseReservation,
  UNRESOLVED_RESERVATION,
} from "#db/processed-payments.ts";
import { readBatchPrimary } from "#db/read.ts";
import { type RowsStatement, sql, typedSql } from "#db/sql.ts";
import { sessionSuccess } from "#routes/api/payment-processing/create.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { decideUnexpectedCreate } from "#routes/api/payment-processing/recovery-decision.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { queueRegistrationSends } from "#shared/webhook/delivery.ts";
import { committedEntries } from "./committed-entries.ts";

type UnexpectedCreateRecovery = {
  error: unknown;
  freeTexts: FreeTextAnswers | undefined;
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
  const [[payment], unresolved, [attendee]] = await readBatchPrimary([
    typedSql<RowsStatement<{ attendee_id: number }>>(
      sql`SELECT processedPayment.attendee_id
              FROM processed_payments AS processedPayment
              JOIN attendees AS attendee
                ON attendee.id = processedPayment.attendee_id
              WHERE processedPayment.payment_session_id = ${sessionId}
                AND attendee.ticket_token_index = ${ticketTokenIndex}`,
    ),
    sql`SELECT 1 AS present FROM processed_payments
              WHERE payment_session_id = ${sessionId} AND ${UNRESOLVED_RESERVATION}`,
    attendeeIdOfToken(ticketTokenIndex),
  ]);
  return {
    finalizedAttendeeId:
      payment === undefined ? null : Number(payment.attendee_id),
    tokenAttendeeId: attendee === undefined ? null : Number(attendee.id),
    unresolved: unresolved.length === 1,
  };
};

/**
 * Resolve an uncertain atomic create from primary state.
 *
 * A create batch carries the booking's whole completion, and a
 * proven-committed booking owes its sends exactly once. The recovery reads
 * the committed entries and queues them with the staged free texts and the
 * renewal token. This arm runs in the one request that lost the result. A
 * later redelivery finds the finalized session and answers send-free. A
 * provable rollback released nothing, so the recovery releases the
 * reservation and answers 503 for the provider's next try. Anything else
 * rethrows while the state settles.
 */
export const recoverOrRefundUnexpectedCreate = async ({
  error,
  freeTexts,
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
    await queueRegistrationSends(entries, {
      // The recovery replays the sends the original create batch owed but
      // never ran. It owns their flags as that batch did: an accepted send
      // clears, a refusal leaves the flag up.
      clearPendingFlagsFor: [decision.attendeeId],
      freeTexts,
      siteTokenIndex: intent.siteTokenIndex,
      source: "public",
    });
    return sessionSuccess(decision.attendeeId, listingId);
  }
  if (decision.kind === "retry") {
    await releaseReservation(session.id);
  }
  throw error;
};
