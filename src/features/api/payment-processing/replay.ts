/* jscpd:ignore-start */
import {
  alreadyProcessedResult,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type {
  BookingIntent,
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { eventGroupHasLegs } from "#shared/accounting/queries.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import {
  finalizeSessionIfUnresolved,
  type ProcessedPayment,
  parseSessionFailure,
} from "#shared/db/processed-payments.ts";
import { logDebug } from "#shared/logger.ts";
import { bookingLedgerDisposition } from "#shared/session-ledger.ts";
/* jscpd:ignore-end */

export const handleReservationConflict = async (
  intent: BookingIntent,
  existing: ProcessedPayment,
): Promise<PaymentResult> => {
  if (existing.attendee_id !== null) {
    return alreadyProcessedResult(intent.items[0]!.e, {
      ...existing,
      attendee_id: existing.attendee_id,
    });
  }
  const failure = await parseSessionFailure(existing.failure_data);
  if (failure) return { ...failure, success: false };
  return {
    error: "Payment is being processed. Please wait a moment and refresh.",
    status: 409,
    success: false,
  };
};

type ReplayInput = {
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
}: ReplayInput): Promise<PaymentResult> => {
  await finalizeSessionIfUnresolved(sessionId, attendeeId, paymentReference);
  logDebug("Payment", `Replayed already-ledgered session ${sessionId}`);
  return sessionSuccess(attendeeId, listingId);
};

const alreadyHandledSession = (
  sessionId: string,
  listingId: number,
): PaymentFailureResult => ({
  detail: `Ledger already records session ${sessionId} with no live booking (listing ${listingId})`,
  error: "This payment has already been processed.",
  status: 200,
  success: false,
});

export const replaySessionFromLedger = async (
  sessionId: string,
  listingId: number,
  paymentReference: string,
): Promise<PaymentResult | null> => {
  const disposition = await bookingLedgerDisposition(sessionId);
  switch (disposition.status) {
    case "unrecorded":
      return null;
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

export const replayBalanceFromLedger = async (
  sessionId: string,
  attendeeId: number,
  listingId: number,
  paymentReference: string,
): Promise<PaymentResult | null> =>
  (await eventGroupHasLegs(await balanceEventGroup(sessionId)))
    ? replaySuccess({ attendeeId, listingId, paymentReference, sessionId })
    : null;
