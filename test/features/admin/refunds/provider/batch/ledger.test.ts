import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  completedRefund,
  failingProvider,
  finishedCounts,
  pendingCandidate,
  processRefundBatchAt,
  provider,
  refundedCandidate,
  rowBackedCandidate,
  rowBackedReference,
  unreadableProvider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  oneFailedRefundCounts,
  recordNoRefunds,
} from "#test/features/admin/refunds/provider/ledger-results.ts";
import {
  postBooking,
  refundCashAmounts,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoneyWith,
  refundObservation,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

const returnedAndStuckCandidate = (attendeeId: number): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [
    rowBackedReference("pi-sess-back", "sess-back", "completed"),
    ...rowBackedCandidate(attendeeId, "sess-stuck", "pi_stuck").references,
  ],
});

describeWithEnv(
  "admin refund provider > processRefundBatch > ledger",
  { db: true },
  () => {
    test("counts a refund the provider could not send as failed", async () => {
      const counts = finishedCounts(
        await processRefundBatchAt(
          provider({
            refund: () =>
              Promise.resolve({ kind: "not_sent", reason: "not_configured" }),
          }),
          [pendingCandidate(34, ["pi_not_sent"])],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
    });

    test("replaying that partial result does not mark recorded money missing", async () => {
      const attendeeId = 32;
      await postBooking({ attendeeId, eventId: "sess-back" });
      await postBooking({ attendeeId, eventId: "sess-stuck" });
      await recordAttendeeRefund(attendeeId, [sessionReference("sess-back")]);
      const claim = grantingRowClaim(
        new Map([[attendeeId, ["sess-back", "sess-stuck"]]]),
      );

      const counts = finishedCounts(
        await processRefundBatchAt(
          failingProvider(),
          [returnedAndStuckCandidate(attendeeId)],
          LISTING,
          { claim },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(claim.unrecorded).toEqual([[]]);
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
    });

    test("a keyless run whose ledger post failed marks the row and lets go", async () => {
      const claim = grantingRowClaim(new Map([[21, ["sess-21"]]]));

      const counts = finishedCounts(
        await processRefundBatchAt(
          failingProvider("keyless"),
          [refundedCandidate(21, "sess-21")],
          LISTING,
          { claim },
        ),
      );

      expect(counts.notRecordedCount).toBe(1);
      expect(claim.released).toEqual([["sess-21"]]);
      expect(claim.unrecorded).toEqual([["sess-21"]]);
    });

    test("keeps every missed row when one attendee has two postings", async () => {
      const attendeeId = 27;
      const claim = grantingRowClaim(
        new Map([[attendeeId, ["sess-first", "sess-second"]]]),
      );

      const counts = finishedCounts(
        await processRefundBatchAt(
          failingProvider(),
          [
            refundedCandidate(attendeeId, "sess-first"),
            refundedCandidate(attendeeId, "sess-second"),
          ],
          LISTING,
          {
            claim,
            record: recordNoRefunds,
          },
        ),
      );

      expect(counts.notRecordedCount).toBe(2);
      expect(claim.unrecorded).toEqual([["sess-first", "sess-second"]]);
    });

    test("releases the row fence while authority observes a sibling charge", async () => {
      const claim = grantingRowClaim(
        new Map([[24, ["sess-back", "sess-stuck"]]]),
      );

      const counts = finishedCounts(
        await processRefundBatchAt(
          provider({
            read: () =>
              Promise.resolve(
                chargeMoneyWith({
                  refunds: [refundObservation({ status: "pending" })],
                }),
              ),
            refund: (request) => Promise.resolve(completedRefund(request)),
          }),
          [returnedAndStuckCandidate(24)],
          LISTING,
          { claim },
        ),
      );

      expect(counts.notRecordedCount).toBe(1);
      expect(claim.released).toEqual([["sess-back", "sess-stuck"]]);
      expect(claim.unrecorded).toEqual([["sess-back"]]);
    });

    test("preserves returned money when sibling evidence cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[25, ["sess-came", "sess-dark"]]]),
      );
      const provider = unreadableProvider("keyed");

      const counts = finishedCounts(
        await processRefundBatchAt(
          provider,
          [
            {
              attendee: { id: 25 } as RefundCandidate["attendee"],
              references: [
                rowBackedReference("pi-sess-came", "sess-came", "completed"),
                ...rowBackedCandidate(25, "sess-dark", "pi_dark").references,
              ],
            },
          ],
          LISTING,
          { claim },
        ),
      );

      expect(provider.refunds).toEqual([]);
      expect(counts).toEqual(oneFailedRefundCounts);
      expect(claim.released).toEqual([["sess-came", "sess-dark"]]);
      expect(claim.unrecorded).toEqual([["sess-came"]]);
    });

    test("a keyed run lets go after its settled answer", async () => {
      const claim = grantingRowClaim(new Map([[22, ["sess-22"]]]));

      await processRefundBatchAt(
        failingProvider(),
        [refundedCandidate(22, "sess-22")],
        LISTING,
        { claim },
      );

      expect(claim.released).toHaveLength(1);
    });

    test("returns all-zero counts for an empty batch", async () => {
      const counts = finishedCounts(
        await processRefundBatchAt(failingProvider(), [], LISTING, {
          claim: grantingRowClaim(),
        }),
      );

      expect(counts).toEqual({
        failedCount: 0,
        notRecordedCount: 0,
        pendingCount: 0,
        refundedCount: 0,
      });
    });

    test("counts a refund the ledger cannot post apart from an uncertain one", async () => {
      const counts = finishedCounts(
        await processRefundBatchAt(
          failingProvider(),
          [refundedCandidate(21, "sess-missing")],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual({
        failedCount: 0,
        notRecordedCount: 1,
        pendingCount: 0,
        refundedCount: 0,
      });
    });
  },
);
