// jscpd:ignore-start -- imports
import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, setDb } from "#shared/db/client.ts";
import { markPaymentReferencesProviderRefunded } from "#shared/db/payment-references.ts";
import {
  getRefundAllSummary,
  loadRefundAllBatch,
} from "#shared/db/refund-all-candidates.ts";
import {
  createPaidListing,
  markAsRefunded,
  seedTaggedBatchAttendees,
} from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  CLAIM_MIRROR,
  putRowState,
  REVIEW_MIRROR,
  refundClaimFixture,
  reviewCase,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { getCompleteRefundCandidatesForListing } from "#test-utils/refund-candidates.ts";

// jscpd:ignore-end

const candidateFor = async (listingId: number, attendeeId: number) => {
  const candidate = (
    await getCompleteRefundCandidatesForListing(listingId)
  ).find(({ attendee }) => attendee.id === attendeeId);
  if (candidate === undefined) {
    throw new Error(`Attendee ${attendeeId} has no refund candidate`);
  }
  return candidate;
};

const paymentRowOf = (candidate: Awaited<ReturnType<typeof candidateFor>>) => {
  const sessionId = candidate.references[0]?.rowSessionIds[0];
  if (sessionId === undefined) {
    throw new Error(`Attendee ${candidate.attendee.id} has no payment row`);
  }
  return sessionId;
};

const databaseReturning = (results: ResultSet[]): Client =>
  ({ batch: () => Promise.resolve(results) }) as unknown as Client;

const resultWithRows = (rows: ResultSet["rows"]): ResultSet => ({
  ...emptyResultSet(),
  rows,
});

describeWithEnv("db > Refund All candidates", { db: true }, () => {
  test("fails loudly when the summary query omits either result layer", async () => {
    setDb(databaseReturning([]));
    await expect(getRefundAllSummary(7)).rejects.toThrow(
      "Refund All admission returned no result",
    );

    setDb(databaseReturning([emptyResultSet()]));
    await expect(getRefundAllSummary(7)).rejects.toThrow(
      "Refund All admission returned no summary",
    );
  });

  test("fails loudly when the batch query omits either result", async () => {
    setDb(databaseReturning([]));
    await expect(loadRefundAllBatch(7)).rejects.toThrow(
      "Refund All admission returned no summary result",
    );

    setDb(
      databaseReturning([
        resultWithRows([
          {
            legacy_unindexed: 0,
            length: 3,
            owner_review: 0,
            total: 0,
            unrecorded_money: 0,
          },
        ]),
      ]),
    );
    await expect(loadRefundAllBatch(7)).rejects.toThrow(
      "Refund All admission returned no batch result",
    );
  });

  test("only a refundable attendee's work blocks the complete summary", async () => {
    const listing = await createPaidListing();
    const settled = await createPaidTestAttendee(
      listing.id,
      "Settled",
      "settled@example.com",
      "pi_settled_summary",
    );
    const active = await createPaidTestAttendee(
      listing.id,
      "Active",
      "active@example.com",
      "pi_active_summary",
    );
    const settledCandidate = await candidateFor(listing.id, settled.id);
    const activeCandidate = await candidateFor(listing.id, active.id);

    await markPaymentReferencesProviderRefunded(settledCandidate.references);
    await markAsRefunded(settled.id);
    await putRowState(
      paymentRowOf(settledCandidate),
      await rowStateSlot({
        review: reviewCase({ kind: "partial_refund" }),
      }),
      REVIEW_MIRROR,
    );
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ''
        WHERE payment_session_id = ?`,
      [paymentRowOf(settledCandidate)],
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: null,
      total: 1,
    });

    await putRowState(
      paymentRowOf(activeCandidate),
      await rowStateSlot({
        review: reviewCase({ kind: "partial_refund" }),
        unrecorded: { returnedAt: "2026-08-13T12:00:00.000Z" },
      }),
      UNRECORDED_MIRROR,
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "unrecorded_money",
      total: 1,
    });
  });

  test("blocks a mixed old and indexed payment history before selecting a batch", async () => {
    const listing = await createPaidListing();
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Mixed Payment",
      "mixed-payment@example.com",
      "pi_old_unindexed",
    );
    const oldPayment = await candidateFor(listing.id, attendee.id);
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ''
        WHERE payment_session_id = ?`,
      [paymentRowOf(oldPayment)],
    );
    await finalizeProcessedPayment("new_indexed_payment", attendee.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_new_indexed",
    });

    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "legacy_unindexed",
      total: 1,
    });
    expect(await loadRefundAllBatch(listing.id)).toMatchObject({
      blockedBy: "legacy_unindexed",
      total: 1,
    });
  });

  test("selects five claim-first attendees as encrypted records", async () => {
    const listing = await createPaidListing();
    await seedTaggedBatchAttendees(listing, "pi_refund_batch_", 7);
    const initial = await loadRefundAllBatch(listing.id);
    const claimedId = initial.attendees[4]?.id;
    if (claimedId === undefined) {
      throw new Error("The full Refund All page has no last attendee");
    }
    const claimed = await candidateFor(listing.id, claimedId);
    await markPaymentReferencesProviderRefunded(claimed.references);
    await markAsRefunded(claimedId);
    await putRowState(
      paymentRowOf(claimed),
      await rowStateSlot({
        claim: refundClaimFixture(
          claimedId,
          "checking",
          "2026-08-13T12:00:00.000Z",
        ),
      }),
      CLAIM_MIRROR,
    );

    const batch = await loadRefundAllBatch(listing.id);
    expect(batch).toMatchObject({ blockedBy: null, total: 7 });
    expect(batch.attendees).toHaveLength(5);
    expect(batch.attendees[0]).toMatchObject({
      id: claimedId,
      quantity: 1,
      refunded: true,
    });
    expect(batch.attendees.every(({ pii_blob }) => pii_blob.length > 0)).toBe(
      true,
    );
  });
});
