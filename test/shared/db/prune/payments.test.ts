import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
} from "#payment/refund-authority.ts";
import { PRUNE_PAYMENTS_RETENTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  claimCurrentAttendeeRows,
  staleClaimSlot,
} from "#test-utils/payment-claim.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";
import {
  insertClaimedPayment,
  insertFailedPayment,
  insertFinalizedPayment,
  insertUnfinalizedPayment,
  paymentExists,
  postRefundCash,
} from "./helpers.ts";

const oldEnoughToPrune = () =>
  new Date(nowMs() - PRUNE_PAYMENTS_RETENTION_MS - 60_000).toISOString();

const insertOldReferencedPayment = async (
  sessionId: string,
  existingAttendeeId?: number,
) => {
  const attendeeId =
    existingAttendeeId ??
    bookedAttendee(
      await bookAttendee(await createTestListing(), {
        email: `${sessionId}@example.com`,
        name: sessionId,
      }),
    ).id;
  await finalizeProcessedPayment(
    sessionId,
    attendeeId,
    "tok",
    taggedPaymentReference(`pi_${sessionId}`),
  );
  await execute(
    "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
    [oldEnoughToPrune(), sessionId],
  );
  return attendeeId;
};

const finishRefundFor = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await postRefundCash(attendeeId);
  const returned = markRefundCompleted(
    readyRefundForTest("keyed", { identityIndex: `${sessionId}-charge` }),
    30,
    "provider",
  );
  await addProviderRefundTestCase(
    `pi_${sessionId}`,
    markRefundLocalRecorded(returned, 31),
    "stripe",
  );
};

describeWithEnv("db > prunePayments", { db: true }, () => {
  test("deletes old finalized payments with no useful refund reference", async () => {
    await insertFinalizedPayment("sess_old", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_old")).toBe(false);
  });

  test("keeps old finalized payments while their refund reference is useful", async () => {
    await insertOldReferencedPayment("sess_refund_useful");

    await runDatabasePruning();

    expect(await paymentExists("sess_refund_useful")).toBe(true);
  });

  test("keeps refund evidence not tied to its exact charge", async () => {
    const attendeeId = await insertOldReferencedPayment("sess_refund_done");
    await postRefundCash(attendeeId);

    await runDatabasePruning();

    expect(await paymentExists("sess_refund_done")).toBe(true);
  });

  test("keeps a sibling payment whose own charge was not returned", async () => {
    const returnedSession = "sess_returned_charge";
    const stillPaidSession = "sess_still_paid_charge";
    const attendeeId = await insertOldReferencedPayment(returnedSession);
    await insertOldReferencedPayment(stillPaidSession, attendeeId);
    await finishRefundFor(returnedSession, attendeeId);

    await runDatabasePruning();

    expect(await paymentExists(returnedSession)).toBe(false);
    expect(await paymentExists(stillPaidSession)).toBe(true);
  });

  test("keeps the payment row that proves an attendee's encrypted payment id", async () => {
    const sessionId = "sess_attendee_provenance";
    const attendeeId = await insertOldReferencedPayment(sessionId);
    await execute(
      "UPDATE attendees SET pii_payment_session_id = ? WHERE id = ?",
      [sessionId, attendeeId],
    );
    await finishRefundFor(sessionId, attendeeId);

    await runDatabasePruning();

    expect(await paymentExists(sessionId)).toBe(true);
  });

  test("keeps old payment links while canonical refund work is active", async () => {
    const sessionId = "sess_authority_active";
    const attendeeId = await insertOldReferencedPayment(sessionId);
    await postRefundCash(attendeeId);
    await addProviderRefundTestCase(
      `pi_${sessionId}`,
      readyRefundTestState("prune-authority-request"),
      "stripe",
    );

    await runDatabasePruning();

    expect(await paymentExists(sessionId)).toBe(true);
  });

  test("keeps finalized payments within retention window", async () => {
    const recent = new Date(nowMs() - 1000).toISOString();
    await insertFinalizedPayment("sess_recent", recent);

    await runDatabasePruning();

    expect(await paymentExists("sess_recent")).toBe(true);
  });

  test("leaves unfinalized reservations alone regardless of age", async () => {
    await insertUnfinalizedPayment("sess_unfinalized", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_unfinalized")).toBe(true);
  });

  test("deletes recorded terminal failures older than retention window", async () => {
    await insertFailedPayment("sess_failed_old", oldEnoughToPrune());

    await runDatabasePruning();

    expect(await paymentExists("sess_failed_old")).toBe(false);
  });

  test("keeps recorded terminal failures within retention window", async () => {
    const recent = new Date(nowMs() - 1000).toISOString();
    await insertFailedPayment("sess_failed_recent", recent);

    await runDatabasePruning();

    expect(await paymentExists("sess_failed_recent")).toBe(true);
  });

  test("keeps an old row a refund run is holding right now", async () => {
    await insertClaimedPayment("sess_claimed_old", oldEnoughToPrune());

    await runDatabasePruning();

    // Deleting it mid-run would throw away the claim, and a later run could
    // then pay the same money a second time.
    expect(await paymentExists("sess_claimed_old")).toBe(true);
  });
});

describeWithEnv(
  "db > prunePayments > a claim that outlived its run",
  { db: true, encryptionKey: true },
  () => {
    test("keeps the row a lost keyless answer is still holding", async () => {
      const attendeeId = await insertOldReferencedPayment("sess_claim_stale");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      // A keyless refund whose answer went missing keeps its claim on purpose,
      // so the claim ages past the point where a live run could still hold it.
      await execute(
        "UPDATE processed_payments SET failure_data = ? WHERE payment_session_id = ?",
        [await staleClaimSlot(attendeeId), "sess_claim_stale"],
      );

      await runDatabasePruning();

      // This row is the only record that money may already be on its way back.
      // Deleting it would take the reference index and the returned-money
      // marker with it, and the next run would send the same payout again.
      expect(await paymentExists("sess_claim_stale")).toBe(true);
    });
  },
);
