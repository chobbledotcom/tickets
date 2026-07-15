import { expect } from "@std/expect";
import { executeBatch } from "#shared/db/client.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { getRefundPaymentReferences } from "#shared/db/payment-references.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";

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
      providerRefunded: false,
      reference: paymentReference,
      sessionIds: [sessionId],
    },
  ]);
};
