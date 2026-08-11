/**
 * Who a refund run picks up.
 *
 * The list is not "people owed money" — it is "people this run still has work
 * for". A hold left behind by a run that finished its money but could not
 * write the release is exactly that work, and nothing else in the system ever
 * takes such a hold off.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getRefundCandidates } from "#routes/admin/refunds/candidates.ts";
import { execute } from "#shared/db/client.ts";
import {
  getRefundPaymentReferencesForAttendee,
  markPaymentReferencesProviderRefunded,
} from "#shared/db/payment-references.ts";
import type { Attendee } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

/** An attendee whose one charge the provider has already returned, so nothing
 *  is still out and their row reads refunded. */
const alreadyReturned = async (
  sessionId: string,
  reference: string,
): Promise<Attendee> => {
  const listing = await createTestListing({ maxAttendees: 50 });
  const created = await bookAttendee(listing, {
    email: `${sessionId}@example.com`,
    name: "Paid Back",
  });
  if (!created.success) throw new Error("booking setup failed");
  const attendee = created.attendees[0]!;
  await finalizeProcessedPayment(sessionId, attendee.id, "", reference);
  await markPaymentReferencesProviderRefunded(
    await getRefundPaymentReferencesForAttendee(
      attendee,
      await getTestPrivateKey(),
    ),
  );
  return { ...attendee, refunded: true };
};

const holdRow = (sessionId: string): Promise<unknown> =>
  execute(
    "UPDATE processed_payments SET protected_state = 'claim' WHERE payment_session_id = ?",
    [sessionId],
  );

const candidateIds = async (attendees: Attendee[]): Promise<number[]> =>
  (await getRefundCandidates(attendees, await getTestPrivateKey())).map(
    (candidate) => candidate.attendee.id,
  );

describeWithEnv("admin refunds > who a run picks up", { db: true }, () => {
  test("leaves an attendee whose money is all back and settled", async () => {
    const settled = await alreadyReturned("sess_settled", "pi_settled");

    expect(await candidateIds([settled])).toEqual([]);
  });

  // The fault this closes: a run that refunded the money, marked the charge and
  // posted the ledger, then lost the write that lets go of its hold. The hold
  // refuses the attendee's delete AND their merge, and it tells the operator to
  // re-run the refund — but they were no longer picked up, so no re-run could
  // ever reach them. The person was stuck for good.
  test("picks up an attendee a run is still holding", async () => {
    const stuck = await alreadyReturned("sess_stuck", "pi_stuck");
    await holdRow("sess_stuck");

    expect(await candidateIds([stuck])).toEqual([stuck.id]);
  });
});
