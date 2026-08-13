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
import { execute } from "#shared/db/client.ts";
import type { Attendee } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  CLAIM_MIRROR,
  freshClaimSlot,
  putRowState,
} from "#test-utils/payment-claim.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { getCompleteRefundCandidates } from "#test-utils/refund-candidates.ts";

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
  await finalizeProcessedPayment(
    sessionId,
    attendee.id,
    "",
    taggedPaymentReference(reference.replaceAll(" ", "-")),
  );
  await markProviderRefundsReturned(
    await getCompleteRefundPaymentReferencesForAttendee(attendee),
  );
  return { ...attendee, refunded: true };
};

/** Put a live claim on the row, record and mirror both, the way a refund run
 *  that has not let go leaves it. */
const holdRow = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await putRowState(sessionId, await freshClaimSlot(attendeeId), CLAIM_MIRROR);
};

const candidateIds = async (attendees: Attendee[]): Promise<number[]> =>
  (await getCompleteRefundCandidates(attendees, await getTestPrivateKey())).map(
    (candidate) => candidate.attendee.id,
  );

const refundableAttendee = async (
  sessionId: string,
  reference: string,
): Promise<Attendee> => {
  const listing = await createTestListing({ maxAttendees: 50 });
  const attendee = bookedAttendee(
    await bookAttendee(listing, {
      email: `${sessionId}@example.com`,
      name: sessionId,
    }),
  );
  await finalizeProcessedPayment(
    sessionId,
    attendee.id,
    "",
    taggedPaymentReference(reference),
  );
  return attendee;
};

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
    await holdRow("sess_stuck", stuck.id);

    expect(await candidateIds([stuck])).toEqual([stuck.id]);
  });

  test("chooses each ticket holder once after dropping no-quantity rows", async () => {
    const repeated = await refundableAttendee(
      "sess_repeated_candidate",
      "pi_repeated_candidate",
    );
    const peer = await refundableAttendee(
      "sess_peer_candidate",
      "pi_peer_candidate",
    );

    expect(
      await candidateIds([
        { ...repeated, quantity: 0 },
        repeated,
        { ...repeated },
        peer,
      ]),
    ).toEqual([repeated.id, peer.id]);
  });

  test("refuses to turn incomplete old payment history into candidates", async () => {
    const attendee = await refundableAttendee(
      "sess_unindexed_candidate",
      "pi_unindexed_candidate",
    );
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ''
        WHERE payment_session_id = ?`,
      ["sess_unindexed_candidate"],
    );

    await expect(candidateIds([attendee])).rejects.toThrow(
      "Test refund candidates contain unindexed payment history",
    );
  });
});
