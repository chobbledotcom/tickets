import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import {
  failingProvider,
  finishedCounts,
  processRefundBatchAt,
  rowBackedReference,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { refundLedgerResult } from "#test-utils/refund-ledger.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

const paidBackCandidate = (
  attendeeId: number,
  sessionIds: readonly string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: sessionIds.map((sessionId) =>
    rowBackedReference(`pi-${sessionId}`, sessionId, "completed"),
  ),
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

describeWithEnv(
  "admin refund provider > exact ledger findings",
  { db: true },
  () => {
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
      await markProviderRefundsReturned(candidate.references, "due");

      const counts = finishedCounts(
        await processRefundBatchAt(failingProvider(), [candidate], LISTING, {
          claim,
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
        }),
      );

      expect(counts).toEqual({
        failedCount: 0,
        notRecordedCount: 1,
        pendingCount: 0,
        refundedCount: 0,
      });
      expect(settlements).toHaveLength(1);
      expect(settlements[0]!.rows.get(recordedSession)).toEqual({
        books: "recorded",
        claim: "release",
        phase: "checking",
      });
      expect(settlements[0]!.rows.get(reviewSession)).toEqual({
        books: "unrecorded",
        claim: "release",
        phase: "checking",
        review: {
          kind: "review",
          reason: { kind: "partially_returned_obligation" },
        },
      });
    });

    test("settles the provider answer and fails when the ledger omits an attendee", async () => {
      const attendeeId = 52;
      const sessionId = "sess-omitted";
      const claim = grantingRowClaim(new Map([[attendeeId, [sessionId]]]));

      const candidate = paidBackCandidate(attendeeId, [sessionId]);
      await markProviderRefundsReturned(candidate.references, "due");
      await expect(
        processRefundBatchAt(failingProvider(), [candidate], LISTING, {
          claim,
          record: () => Promise.resolve(new Map()),
        }),
      ).rejects.toThrow("Refund ledger omitted attendee 52");
      expect(claim.released).toEqual([[sessionId]]);
    });
  },
);
