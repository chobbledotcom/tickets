import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import {
  postBooking,
  sessionReference,
} from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";

const LISTING = 7;

/** A candidate already refunded at the provider (its references carry
 * `refundState: "completed"`, so the provider is never called for it). */
const refundedCandidate = (
  attendeeId: number,
  sessionId: string,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [sessionReference(sessionId)],
});

const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) => ({
    reference,
    refundState: "none" as const,
    sessionIds: [] as string[],
  })) as RefundPaymentReference[],
});

/** Provider that fails every live refund and throws for references in
 * `throws`; used to drive the failed/errored tally branches. */
const failingProvider = (throws: Set<string>) => ({
  readChargeMoneyOrNull: () => Promise.resolve(chargeMoney()),
  refundPayment: (reference: string) => {
    if (throws.has(reference)) throw new Error(`boom ${reference}`);
    return Promise.resolve(false);
  },
});

describeWithEnv(
  "admin refund provider > processRefundBatch",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("tallies refunded, failed and errored candidates in one batch", async () => {
      await postBooking({ attendeeId: 11, eventId: "sess-11" });

      const counts = await processRefundBatch(
        failingProvider(new Set(["pi_boom"])),
        [
          refundedCandidate(11, "sess-11"),
          pendingCandidate(12, ["pi_fail"]),
          pendingCandidate(13, ["pi_boom", "pi_two"]),
        ],
        LISTING,
      );

      expect(counts).toEqual({
        errorCount: 1,
        failedCount: 1,
        refundedCount: 1,
      });
      expect(errors.contains("Admin bulk refund failed for attendee 12")).toBe(
        true,
      );
      // The errored candidate's references are joined with ", ".
      expect(
        errors.contains(
          "Admin bulk refund errored for attendee 13, payments pi_boom, pi_two",
        ),
      ).toBe(true);
    });

    test("returns all-zero counts for an empty batch", async () => {
      const counts = await processRefundBatch(
        failingProvider(new Set()),
        [],
        LISTING,
      );

      expect(counts).toEqual({
        errorCount: 0,
        failedCount: 0,
        refundedCount: 0,
      });
    });

    test("counts a provider-refunded attendee the ledger cannot post as an error", async () => {
      // No booking exists for attendee 21, so the reversal posts nothing and the
      // ledger reports it unposted even though the provider refund succeeded.
      const counts = await processRefundBatch(
        failingProvider(new Set()),
        [refundedCandidate(21, "sess-missing")],
        LISTING,
      );

      expect(counts).toEqual({
        errorCount: 1,
        failedCount: 0,
        refundedCount: 0,
      });
    });
  },
);
