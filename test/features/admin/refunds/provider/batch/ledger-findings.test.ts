import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import {
  failingProvider,
  finishedCounts,
  processRefundBatchAt,
  provider,
  rowBackedReference,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { sessionReference } from "#test/shared/refund-ledger/helpers.ts";
import {
  chargeMoney,
  partlyRefundedCharge,
} from "#test-utils/payment-state.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

const paidBackCandidate = (
  attendeeId: number,
  sessionIds: readonly string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: sessionIds.map(sessionReference),
});

const observingClaim = (
  attendeeId: number,
  sessionIds: readonly string[],
  settlements: RowSettlement[],
): RowClaim => {
  const granted = grantingRowClaim(new Map([[attendeeId, sessionIds]]));
  return {
    claim: granted.claim,
    settle: (settlement) => {
      settlements.push(settlement);
      return granted.settle(settlement);
    },
  };
};

describe("admin refund provider > exact ledger findings", () => {
  test("records a provider conflict on only the row that reported it", async () => {
    const attendeeId = 50;
    const cleanSession = "sess-clean";
    const reviewSession = "sess-partial";
    const claim = grantingRowClaim(
      new Map([[attendeeId, [cleanSession, reviewSession]]]),
    );
    const candidate: RefundCandidate = {
      attendee: { id: attendeeId } as RefundCandidate["attendee"],
      references: [
        rowBackedReference("pi_clean", cleanSession),
        rowBackedReference("pi_partial", reviewSession),
      ],
    };
    const source = provider({
      read: (reference) =>
        Promise.resolve(
          reference === "pi_partial" ? partlyRefundedCharge() : chargeMoney(),
        ),
    });

    const counts = finishedCounts(
      await processRefundBatchAt(source, [candidate], LISTING, { claim }),
    );

    expect(source.refunds).toEqual([]);
    expect(counts.failedCount).toBe(1);
    expect(claim.reviewChanges).toEqual([
      new Map([
        [reviewSession, { kind: "review", reason: { kind: "partial_refund" } }],
      ]),
    ]);
  });

  test("settles each returned reference from its own ledger result", async () => {
    const attendeeId = 51;
    const recordedSession = "sess-recorded";
    const reviewSession = "sess-review";
    const settlements: RowSettlement[] = [];
    const claim = observingClaim(
      attendeeId,
      [recordedSession, reviewSession],
      settlements,
    );
    const candidate = paidBackCandidate(attendeeId, [
      recordedSession,
      reviewSession,
    ]);

    const counts = finishedCounts(
      await processRefundBatchAt(
        failingProvider(new Set()),
        [candidate],
        LISTING,
        {
          claim,
          markReturned: () => Promise.resolve(),
          record: (postings) => {
            const posting = postings[0];
            if (postings.length !== 1 || posting === undefined) {
              throw new Error("Expected one attendee ledger posting");
            }
            const [recordedReference, reviewReference] = posting.references;
            if (
              posting.references.length !== 2 ||
              recordedReference === undefined ||
              reviewReference === undefined
            ) {
              throw new Error("Expected two returned references");
            }
            return Promise.resolve(
              new Map([
                [
                  attendeeId,
                  refundLedgerResult(
                    [recordedReference],
                    [reviewReference],
                    [reviewReference],
                  ),
                ],
              ]),
            );
          },
        },
      ),
    );

    expect(counts).toEqual({
      errorCount: 0,
      failedCount: 0,
      notRecordedCount: 1,
      pendingCount: 0,
      refundedCount: 0,
    });
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.rows.get(recordedSession)).toEqual({
      books: "recorded",
      claim: "release",
    });
    expect(settlements[0]!.rows.get(reviewSession)).toEqual({
      books: "unrecorded",
      claim: "release",
      review: {
        kind: "review",
        reason: { kind: "partially_returned_obligation" },
      },
    });
  });

  test("keeps the claim and fails when the ledger omits an attendee", async () => {
    const attendeeId = 52;
    const sessionId = "sess-omitted";
    const claim = grantingRowClaim(new Map([[attendeeId, [sessionId]]]));

    await expect(
      processRefundBatchAt(
        failingProvider(new Set()),
        [paidBackCandidate(attendeeId, [sessionId])],
        LISTING,
        {
          claim,
          markReturned: () => Promise.resolve(),
          record: () => Promise.resolve(new Map()),
        },
      ),
    ).rejects.toThrow("Refund ledger omitted attendee 52");
    expect(claim.released).toEqual([]);
  });
});
