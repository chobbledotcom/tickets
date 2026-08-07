import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { executeBatch, queryOne } from "#shared/db/client.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import {
  type ProcessedPayment,
  reserveSession,
} from "#shared/db/processed-payments.ts";

export const getProcessedPayment = (
  sessionId: string,
): Promise<ProcessedPayment | null> =>
  queryOne<ProcessedPayment>(
    "SELECT payment_session_id, attendee_id, processed_at, ticket_tokens, failure_data, payment_reference, provider_refunded_at " +
      "FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

export const expectSessionFailed = async (sessionId: string): Promise<void> => {
  const record = await getProcessedPayment(sessionId);
  if (!record) throw new Error(`Processed payment ${sessionId} was not stored`);
  expect(record.attendee_id).toBeNull();
  const failureData: unknown = record.failure_data;
  assert(
    typeof failureData === "string",
    `Processed payment ${sessionId} failure data was not a string`,
  );
  expect(failureData.length).toBeGreaterThan(0);
};

/** Finalize a reserved payment through the same guarded batch as checkout. */
export const finalizeReservedPayment = async (
  sessionId: string,
  attendeeId: number,
  ticketToken = "tok-test",
  paymentReference = `pi_${sessionId}`,
): Promise<void> => {
  await executeBatch(
    await batchFinalizeStatements(
      sessionId,
      "?",
      attendeeId,
      paymentReference,
      ticketToken,
    ),
  );
};

/** Reserve and finalize a payment row for tests that only need completed state. */
export const finalizeProcessedPayment = async (
  sessionId: string,
  attendeeId: number,
  ticketToken = "tok-test",
  paymentReference = `pi_${sessionId}`,
): Promise<void> => {
  await reserveSession(sessionId);
  await finalizeReservedPayment(
    sessionId,
    attendeeId,
    ticketToken,
    paymentReference,
  );
};

/** Assert the exact decrypted provider reference attached to one attendee. */
export const expectProcessedPaymentReference = async (
  attendeeId: number,
  sessionId: string,
  paymentReference: string,
  privateKey: CryptoKey,
): Promise<void> => {
  expect(
    (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        privateKey,
      )
    ).get(attendeeId),
  ).toEqual([
    {
      reference: paymentReference,
      refundState: "none",
      sessionIds: [sessionId],
    },
  ]);
};
