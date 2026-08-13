import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  candidate,
  finishedCounts,
  pendingCandidate,
  processRefundBatchAt,
  provider,
  rowBackedCandidate,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { oneFailedRefundCounts } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

type BatchEntry = {
  readonly candidate: RefundCandidate;
  readonly id: number;
  readonly reference: string;
  readonly sessionId: string;
};

const candidateBatch = (name: string): BatchEntry[] =>
  Array.from({ length: 2 }, (_, offset) => {
    const id = 100 + offset;
    const reference = `pi_${name}_${id}`;
    const sessionId = `sess_${name}_${id}`;
    const candidate = rowBackedCandidate(id, sessionId, reference);
    return {
      candidate,
      id,
      reference,
      sessionId,
    };
  });

const heldRows = (
  entries: readonly BatchEntry[],
): ReadonlyMap<number, readonly string[]> =>
  new Map(entries.map(({ id, sessionId }) => [id, [sessionId]]));

describeWithEnv(
  "admin refund provider > processRefundBatch > claims",
  { db: true },
  () => {
    const errors = setupErrorSpy();

    test("counts and reports an unreadable charge without sending", async () => {
      const counts = finishedCounts(
        await processRefundBatchAt(
          provider({ read: () => Promise.resolve(null) }),
          [pendingCandidate(21, ["pi_unreadable"])],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(
        errors.contains("Admin refund not started (provider_evidence)"),
      ).toBe(true);
    });

    test("does not report an already-returned sibling as a fresh observation", async () => {
      const source = provider({
        read: (reference) =>
          Promise.resolve(
            reference === "pi_unreadable_sibling" ? null : chargeMoney(),
          ),
      });

      const counts = finishedCounts(
        await processRefundBatchAt(
          source,
          [
            candidate(
              [
                { reference: "pi_already_back", refundState: "completed" },
                { reference: "pi_unreadable_sibling" },
                { reference: "pi_observed_sibling" },
              ],
              22,
            ),
          ],
          LISTING,
          { claim: grantingRowClaim() },
        ),
      );

      expect(counts).toEqual(oneFailedRefundCounts);
      expect(source.reads).toEqual([
        "pi_unreadable_sibling",
        "pi_observed_sibling",
      ]);
      expect(source.refunds).toEqual([]);
    });

    test("releases checking fences when owner review blocks admission", async () => {
      const entries = candidateBatch("blocked_review");
      const reviewed = entries[1];
      if (reviewed === undefined) {
        throw new Error("No blocked review fixture");
      }
      const claim = grantingRowClaim(
        heldRows(entries),
        new Map(),
        new Map([[reviewed.sessionId, { kind: "partial_refund" }]]),
      );
      const source = provider();

      await processRefundBatchAt(
        source,
        entries.map(({ candidate }) => candidate),
        LISTING,
        { claim },
      );

      expect([...source.reads, ...source.refunds]).toEqual([]);
      expect(claim.released).toEqual([entries.map(({ sessionId }) => sessionId)]);
    });
  },
);
