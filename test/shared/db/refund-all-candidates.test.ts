// jscpd:ignore-start -- imports
import type { Client, ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, setDb } from "#shared/db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  getRefundAllSummary,
  loadRefundAllBatch,
} from "#shared/db/refund-all-candidates.ts";
import {
  armRefundSend,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { markRefundOwnerChoiceNeeded } from "#shared/payment/refund-authority-choice.ts";
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
  refundClaimFixture,
  REVIEW_MIRROR,
  reviewCase,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { addProviderRefundTestCase } from "#test-utils/provider-refund-cases.ts";
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
            provider_refund: 0,
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
      "",
    );
    const active = await createPaidTestAttendee(
      listing.id,
      "Active",
      "active@example.com",
      "",
    );
    await finalizeProcessedPayment("settled-summary", settled.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_settled_summary",
    });
    await finalizeProcessedPayment("active-summary", active.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_active_summary",
    });
    const modernSettledCandidate = await candidateFor(listing.id, settled.id);
    const activeCandidate = await candidateFor(listing.id, active.id);
    await markProviderRefundsReturned(modernSettledCandidate.references);
    await markAsRefunded(settled.id);
    await putRowState(
      paymentRowOf(modernSettledCandidate),
      await rowStateSlot({
        review: reviewCase({ kind: "partially_returned_obligation" }),
      }),
      REVIEW_MIRROR,
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: null,
      total: 1,
    });

    await putRowState(
      paymentRowOf(activeCandidate),
      await rowStateSlot({
        review: reviewCase({ kind: "partially_returned_obligation" }),
        unrecorded: { returnedAt: "2026-08-13T12:00:00.000Z" },
      }),
      UNRECORDED_MIRROR,
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "unrecorded_money",
      total: 1,
    });
  });

  test("blocks a mixed unindexed and indexed history before selecting a batch", async () => {
    const listing = await createPaidListing();
    const attendee = await createPaidTestAttendee(
      listing.id,
      "Mixed Payment",
      "mixed-payment@example.com",
      "",
    );
    await finalizeProcessedPayment("old_unindexed_payment", attendee.id, "", {
      kind: "tagged",
      provider: "stripe",
      reference: "pi_old_unindexed",
    });
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

  test("selects one claim-first attendee as an encrypted record", async () => {
    const listing = await createPaidListing();
    await seedTaggedBatchAttendees(listing, "pi_refund_batch_", 7);
    const claimed = (await getCompleteRefundCandidatesForListing(listing.id))[
      4
    ];
    if (claimed === undefined) {
      throw new Error("Refund All has no fifth attendee");
    }
    const claimedId = claimed.attendee.id;
    await markProviderRefundsReturned(claimed.references);
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
    expect(batch.attendees).toHaveLength(1);
    expect(batch.attendees[0]).toMatchObject({
      id: claimedId,
      quantity: 1,
      refunded: true,
    });
    expect(batch.attendees.every(({ pii_blob }) => pii_blob.length > 0)).toBe(
      true,
    );
  });

  test("blocks canonical provider work outside the selected batch", async () => {
    const listing = await createPaidListing();
    await seedTaggedBatchAttendees(listing, "pi_authority_batch_", 7);
    const initial = await loadRefundAllBatch(listing.id);
    const selected = new Set(initial.attendees.map(({ id }) => id));
    const outside = (await getCompleteRefundCandidatesForListing(listing.id))
      .find(({ attendee }) => !selected.has(attendee.id));
    const reference = outside?.references[0];
    if (reference === undefined || reference.kind !== "tagged") {
      throw new Error(
        "Refund All has no tagged payment outside its first page",
      );
    }
    const ready = readyRefund({
      evidenceRevision: 1,
      nextActionAt: 20,
      now: 10,
      request: {
        capability: "keyed",
        generation: 1,
        identityIndex: "refund-all-owner-case",
        replayUntil: 30,
      },
    });
    const ownerWork = markRefundOwnerChoiceNeeded(
      armRefundSend(ready, 11, 20),
      12,
      "provider_conflict",
    );
    await addProviderRefundTestCase(
      reference.reference,
      ownerWork,
      reference.provider,
    );

    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "provider_refund",
      total: 7,
    });
    expect(await loadRefundAllBatch(listing.id)).toMatchObject({
      blockedBy: "provider_refund",
      total: 7,
    });
  });

  test("narrows the complete set before selecting any attendee PII", async () => {
    const listing = await createPaidListing();
    await seedTaggedBatchAttendees(listing, "pi_bounded_pii_", 7);

    const statements = await runWithQueryLogContext(async () => {
      enableQueryLog();
      await loadRefundAllBatch(listing.id);
      return getQueryLog().map(({ sql }) => sql);
    });
    const [summary, batch] = statements;
    if (summary === undefined || batch === undefined) {
      throw new Error("Refund All did not issue both admission reads");
    }
    expect(summary).not.toContain("pii_blob");
    expect(batch.indexOf("LIMIT ?")).toBeGreaterThan(-1);
    expect(batch.indexOf("attendee.pii_blob")).toBeGreaterThan(
      batch.indexOf("LIMIT ?"),
    );
  });
});
