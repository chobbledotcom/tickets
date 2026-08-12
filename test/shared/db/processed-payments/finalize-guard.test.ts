import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch } from "#shared/db/client.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import {
  decryptSessionTokens,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  expectProcessedPaymentReference,
  getProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

/** One reserved payment belonging to a fresh attendee. */
const reserveAttendeePayment = async (sessionId: string): Promise<number> => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const attendeeId = bookedAttendee(await bookAttendee(listing)).id;
  await reserveSession(sessionId);
  return attendeeId;
};

describeWithEnv("db > processed payment finalize guard", { db: true }, () => {
  test("finalizes a free session without storing a charge reference", async () => {
    const attendeeId = await reserveAttendeePayment("free-finalize");

    await executeBatch(
      await batchFinalizeStatements(
        "free-finalize",
        "?",
        attendeeId,
        null,
        "free-token",
      ),
    );

    const finalized = await getProcessedPayment("free-finalize");
    expect(finalized?.attendee_id).toBe(attendeeId);
    expect(finalized?.payment_reference).toBe("");
    expect(await decryptSessionTokens(finalized!.ticket_tokens)).toBe(
      "free-token",
    );
  });

  test("rejects a missing session", async () => {
    await expect(
      executeBatch(
        await batchFinalizeStatements(
          "missing-finalize",
          "?",
          10,
          taggedPaymentReference("pi_missing"),
          "stable-token",
        ),
      ),
    ).rejects.toThrow("processed_payments.processed_at");
  });

  test("rejects an already-finalized session without changing it", async () => {
    const attendeeId = await reserveAttendeePayment("already-finalized");
    await executeBatch(
      await batchFinalizeStatements(
        "already-finalized",
        "?",
        attendeeId,
        taggedPaymentReference("pi_first"),
        "first-token",
      ),
    );
    const finalized = await getProcessedPayment("already-finalized");
    expect(finalized!.attendee_id).toBe(attendeeId);
    expect(await decryptSessionTokens(finalized!.ticket_tokens)).toBe(
      "first-token",
    );
    await expectProcessedPaymentReference(
      attendeeId,
      "already-finalized",
      taggedPaymentReference("pi_first"),
      await getTestPrivateKey(),
    );

    await expect(
      executeBatch(
        await batchFinalizeStatements(
          "already-finalized",
          "?",
          attendeeId + 1,
          taggedPaymentReference("pi_second"),
          "second-token",
        ),
      ),
    ).rejects.toThrow("processed_payments.processed_at");

    const row = await getProcessedPayment("already-finalized");
    expect(row).toEqual(finalized);
    await expectProcessedPaymentReference(
      attendeeId,
      "already-finalized",
      taggedPaymentReference("pi_first"),
      await getTestPrivateKey(),
    );
  });
});
