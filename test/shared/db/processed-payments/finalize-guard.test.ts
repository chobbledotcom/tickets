import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch } from "#shared/db/client.ts";
import { batchFinalizeStatements } from "#shared/db/payment-finalize.ts";
import {
  decryptSessionTokens,
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectProcessedPaymentReference } from "#test-utils/processed-payments.ts";

describeWithEnv("db > processed payment finalize guard", { db: true }, () => {
  test("rejects a missing session", async () => {
    await expect(
      executeBatch(
        await batchFinalizeStatements(
          "missing-finalize",
          "?",
          10,
          "pi_missing",
          "stable-token",
        ),
      ),
    ).rejects.toThrow("processed_payments.processed_at");
  });

  test("rejects an already-finalized session without changing it", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await bookAttendee(listing);
    if (!attendee.success) throw new Error("attendee setup failed");
    const attendeeId = attendee.attendees[0]!.id;
    await reserveSession("already-finalized");
    await executeBatch(
      await batchFinalizeStatements(
        "already-finalized",
        "?",
        attendeeId,
        "pi_first",
        "first-token",
      ),
    );
    const finalized = await isSessionProcessed("already-finalized");
    expect(finalized!.attendee_id).toBe(attendeeId);
    expect(await decryptSessionTokens(finalized!.ticket_tokens)).toBe(
      "first-token",
    );
    await expectProcessedPaymentReference(
      attendeeId,
      "already-finalized",
      "pi_first",
      await getTestPrivateKey(),
    );

    await expect(
      executeBatch(
        await batchFinalizeStatements(
          "already-finalized",
          "?",
          attendeeId + 1,
          "pi_second",
          "second-token",
        ),
      ),
    ).rejects.toThrow("processed_payments.processed_at");

    const row = await isSessionProcessed("already-finalized");
    expect(row).toEqual(finalized);
    await expectProcessedPaymentReference(
      attendeeId,
      "already-finalized",
      "pi_first",
      await getTestPrivateKey(),
    );
  });
});
