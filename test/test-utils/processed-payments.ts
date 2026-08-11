import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { executeBatch, queryOne } from "#shared/db/client.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import {
  getRefundPaymentReferences,
  paymentReferenceIndex,
} from "#shared/db/payment-references.ts";
import {
  type ProcessedPayment,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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

/** One attendee on a fresh listing, holding one finalized payment row. The
 *  starting point for every test about what a live payment lets you do. */
export const bookedWithPayment = async (
  sessionId: string,
  paymentReference: string,
): Promise<number> => {
  const listing = await createTestListing();
  const booked = await bookAttendee(listing, {
    email: "buyer@example.com",
    name: "Buyer",
  });
  const attendeeId = bookedAttendee(booked).id;
  await finalizeProcessedPayment(
    sessionId,
    attendeeId,
    "tok",
    paymentReference,
  );
  return attendeeId;
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
      index: await paymentReferenceIndex(paymentReference),
      reference: paymentReference,
      refundState: "none",
      rowSessionIds: [sessionId],
      sessionIds: [sessionId],
    },
  ]);
};

/** The blind index stored beside one row's payment reference. */
export const referenceIndexOf = async (
  sessionId: string,
): Promise<string | undefined> =>
  (
    await queryOne<{ payment_reference_index: string }>(
      "SELECT payment_reference_index FROM processed_payments WHERE payment_session_id = ?",
      [sessionId],
    )
  )?.payment_reference_index;
