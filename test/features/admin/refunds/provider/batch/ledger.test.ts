import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import {
  completedRefund,
  failingProvider,
  finishedCounts,
  oneFailedRefundCounts,
  pendingCandidate,
  refundedCandidate,
  unreadableProvider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  legacyReference,
  postBooking,
  refundCashAmounts,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  refundObservation,
  refundReference,
} from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

const returnedAndStuckCandidate = (attendeeId: number): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [
    sessionReference("sess-back"),
    refundReference("pi_stuck", {
      rowSessionIds: ["sess-stuck"],
      sessionIds: ["sess-stuck"],
    }),
  ],
});

describeWithEnv(
  "admin refund provider > processRefundBatch > ledger",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("tallies refunded, failed and errored candidates in one batch", async () => {
      await postBooking({ attendeeId: 11, eventId: "sess-11" });

      const counts = finishedCounts(
        await processRefundBatch(
          failingProvider(new Set(["pi_boom"])),
          [
            refundedCandidate(11, "sess-11"),
            pendingCandidate(12, ["pi_fail"]),
            pendingCandidate(13, ["pi_boom", "pi_two"]),
          ],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual({
        errorCount: 1,
        failedCount: 1,
        notRecordedCount: 0,
        pendingCount: 0,
        refundedCount: 1,
      });
      expect(errors.contains("Admin bulk refund failed for attendee 12")).toBe(
        true,
      );
      expect(
        errors.contains(
          "Admin bulk refund errored for attendee 13, payments pi_boom, pi_two",
        ),
      ).toBe(true);
    });

    test("records the charges that came back when a sibling is refused", async () => {
      const attendeeId = 31;
      await postBooking({ attendeeId, eventId: "sess-back" });
      await postBooking({ attendeeId, eventId: "sess-stuck" });

      const counts = finishedCounts(
        await processRefundBatch(
          {
            readCharge: () =>
              Promise.resolve({
                resource: chargeMoney(),
                status: "found",
              } as const),
            refundCapability: "keyed" as const,
            refundCharge: (request: RefundRequest) =>
              Promise.resolve<RefundAttemptResult>(
                request.paymentReference === "pi_back"
                  ? completedRefund(request)
                  : { kind: "rejected", reason: "failed" },
              ),
          },
          [
            {
              attendee: { id: attendeeId } as RefundCandidate["attendee"],
              references: [
                refundReference("pi_back", { sessionIds: ["sess-back"] }),
                refundReference("pi_stuck", { sessionIds: ["sess-stuck"] }),
              ],
            },
          ],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(await refundCashAmounts(attendeeId)).toEqual([5000]);
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
        await processRefundBatch(
          failingProvider(new Set()),
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
        await processRefundBatch(
          failingProvider(new Set(), "keyless"),
          [refundedCandidate(21, "sess-21")],
          LISTING,
          { claim },
        ),
      );

      expect(counts.notRecordedCount).toBe(1);
      expect(counts.errorCount).toBe(0);
      expect(claim.released).toEqual([["sess-21"]]);
      expect(claim.unrecorded).toEqual([["sess-21"]]);
    });

    test("keeps every missed row when one attendee has two postings", async () => {
      const attendeeId = 27;
      const claim = grantingRowClaim(
        new Map([[attendeeId, ["sess-first", "sess-second"]]]),
      );

      const counts = finishedCounts(
        await processRefundBatch(
          failingProvider(new Set()),
          [
            refundedCandidate(attendeeId, "sess-first"),
            refundedCandidate(attendeeId, "sess-second"),
          ],
          LISTING,
          {
            claim,
            record: () => Promise.resolve(new Map([[attendeeId, false]])),
          },
        ),
      );

      expect(counts.notRecordedCount).toBe(2);
      expect(claim.unrecorded).toEqual([["sess-first", "sess-second"]]);
    });

    test("retains the whole claim while a sibling charge is in doubt", async () => {
      const claim = grantingRowClaim(
        new Map([[24, ["sess-back", "sess-stuck"]]]),
      );

      const counts = finishedCounts(
        await processRefundBatch(
          {
            readCharge: () =>
              Promise.resolve({
                resource: chargeMoneyWith({
                  refunds: [refundObservation({ status: "pending" })],
                }),
                status: "found",
              } as const),
            refundCapability: "keyed" as const,
            refundCharge: (request: RefundRequest) =>
              Promise.resolve(completedRefund(request)),
          },
          [returnedAndStuckCandidate(24)],
          LISTING,
          { claim },
        ),
      );

      expect(counts.notRecordedCount).toBe(1);
      expect(claim.released).toEqual([]);
      expect(claim.unrecorded).toEqual([]);
    });

    test("marks returned money even when a sibling charge is in doubt", async () => {
      const claim = grantingRowClaim(
        new Map([[25, ["sess-came", "sess-dark"]]]),
      );
      const provider = unreadableProvider("keyed");

      const counts = finishedCounts(
        await processRefundBatch(
          provider,
          [
            {
              attendee: { id: 25 } as RefundCandidate["attendee"],
              references: [
                sessionReference("sess-came"),
                refundReference("pi_dark", {
                  rowSessionIds: ["sess-dark"],
                  sessionIds: ["sess-dark"],
                }),
              ],
            },
          ],
          LISTING,
          { claim },
        ),
      );

      expect(provider.sent).toEqual([]);
      expect(counts.notRecordedCount).toBe(1);
      expect(claim.released).toEqual([["sess-came", "sess-dark"]]);
      expect(claim.unrecorded).toEqual([["sess-came"]]);
    });

    test("marks the anchor row a returned legacy charge is held by", async () => {
      const anchor = anchorSessionId(26, "index_of_pi_legacy");
      const claim = grantingRowClaim(new Map([[26, [anchor]]]));

      const counts = finishedCounts(
        await processRefundBatch(
          failingProvider(new Set()),
          [
            {
              attendee: { id: 26 } as RefundCandidate["attendee"],
              references: [legacyReference("pi_legacy")],
            },
          ],
          LISTING,
          { claim },
        ),
      );

      expect(counts.notRecordedCount).toBe(1);
      expect(claim.released).toEqual([[anchor]]);
      expect(claim.unrecorded).toEqual([[anchor]]);
    });

    test("a keyed run lets go after its settled answer", async () => {
      const claim = grantingRowClaim(new Map([[22, ["sess-22"]]]));

      await processRefundBatch(
        failingProvider(new Set()),
        [refundedCandidate(22, "sess-22")],
        LISTING,
        { claim },
      );

      expect(claim.released).toHaveLength(1);
    });

    test("returns all-zero counts for an empty batch", async () => {
      const counts = finishedCounts(
        await processRefundBatch(failingProvider(new Set()), [], LISTING, {
          claim: grantingRowClaim(),
        }),
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 0,
        notRecordedCount: 0,
        pendingCount: 0,
        refundedCount: 0,
      });
    });

    test("counts a refund the ledger cannot post apart from an uncertain one", async () => {
      const counts = finishedCounts(
        await processRefundBatch(
          failingProvider(new Set()),
          [refundedCandidate(21, "sess-missing")],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 0,
        notRecordedCount: 1,
        pendingCount: 0,
        refundedCount: 0,
      });
    });
  },
);
