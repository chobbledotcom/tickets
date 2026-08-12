import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";
import { BULK_REFUND_LIMIT } from "#shared/subrequest-budget.ts";
import { armEveryRefund } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  finishedCounts,
  pendingCandidate,
  processRefundBatchAt,
  provider,
  rowBackedCandidate,
  unreadableProvider,
} from "#test/features/admin/refunds/provider/helpers.ts";
import { oneFailedRefundCounts } from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const LISTING = 7;

type BatchEntry = {
  readonly candidate: RefundCandidate;
  readonly id: number;
  readonly index: string;
  readonly reference: string;
  readonly sessionId: string;
};

const candidateBatch = (name: string): BatchEntry[] =>
  Array.from({ length: BULK_REFUND_LIMIT + 1 }, (_, offset) => {
    const id = 100 + offset;
    const reference = `pi_${name}_${id}`;
    const sessionId = `sess_${name}_${id}`;
    const candidate = rowBackedCandidate(id, sessionId, reference);
    return {
      candidate,
      id,
      index: `index_of_stripe_${reference}`,
      reference,
      sessionId,
    };
  });

const heldRows = (
  entries: readonly BatchEntry[],
): ReadonlyMap<number, readonly string[]> =>
  new Map(entries.map(({ id, sessionId }) => [id, [sessionId]]));

const inheritedRows = (
  entries: readonly BatchEntry[],
  capability: RefundProviderCapability,
) =>
  new Map(entries.map(({ id, index }) => [id, new Map([[index, capability]])]));

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
        errors.contains(
          "No configured payment provider recognizes this payment. " +
            "Add the provider it was taken with, or refund it from that " +
            "provider's dashboard.",
        ),
      ).toBe(true);
    });

    test("keeps a resumed keyless hold when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[31, ["sess-31"]]]),
        new Map([[31, new Map([["index_of_stripe_pi_sess-31", "keyless"]])]]),
      );
      const provider = unreadableProvider("keyless");

      await processRefundBatchAt(
        provider,
        [rowBackedCandidate(31, "sess-31")],
        LISTING,
        { claim },
      );

      expect(provider.refunds).toEqual([]);
      expect(claim.released).toEqual([]);
    });

    test("keeps an inherited keyless hold even when this run is keyed", async () => {
      const claim = grantingRowClaim(
        new Map([[34, ["sess-34"]]]),
        new Map([[34, new Map([["index_of_stripe_pi_sess-34", "keyless"]])]]),
      );
      const provider = unreadableProvider("keyed");

      await processRefundBatchAt(
        provider,
        [rowBackedCandidate(34, "sess-34")],
        LISTING,
        { claim },
      );

      expect(provider.refunds).toEqual([]);
      expect(claim.released).toEqual([]);
    });

    test("lets a fresh keyless hold go when the provider cannot be read", async () => {
      const claim = grantingRowClaim(new Map([[32, ["sess-32"]]]));
      const provider = unreadableProvider("keyless");

      await processRefundBatchAt(
        provider,
        [rowBackedCandidate(32, "sess-32")],
        LISTING,
        { claim },
      );

      expect(provider.refunds).toEqual([]);
      expect(claim.released).toEqual([["sess-32"]]);
    });

    test("keeps a resumed keyed hold when the provider cannot be read", async () => {
      const claim = grantingRowClaim(
        new Map([[33, ["sess-33"]]]),
        new Map([[33, new Map([["index_of_stripe_pi_sess-33", "keyed"]])]]),
      );
      const provider = unreadableProvider("keyed");

      await processRefundBatchAt(
        provider,
        [rowBackedCandidate(33, "sess-33")],
        LISTING,
        { claim },
      );

      expect(provider.refunds).toEqual([]);
      expect(claim.released).toEqual([]);
    });

    test("reconciles inherited work beyond the fresh execution limit first", async () => {
      const entries = candidateBatch("inherited_priority");
      const stale = entries[BULK_REFUND_LIMIT];
      if (stale === undefined) throw new Error("No inherited overflow fixture");
      const claim = grantingRowClaim(
        heldRows(entries),
        inheritedRows([stale], "keyless"),
      );
      const source = provider();
      const armFreshRefund = armEveryRefund();

      await processRefundBatchAt(
        source,
        entries.map(({ candidate }) => candidate),
        LISTING,
        {
          arm: (request) =>
            request.indexes.includes(stale.index)
              ? Promise.resolve({
                  indexes: [stale.index],
                  kind: "owner_review",
                  reason: "uncertain_keyless_refund",
                })
              : armFreshRefund(request),
          claim,
        },
      );

      const fresh = entries.slice(0, BULK_REFUND_LIMIT - 1);
      expect(source.reads).toEqual([
        stale.reference,
        ...fresh.map(({ reference }) => reference),
      ]);
      expect(source.refunds).toEqual(fresh.map(({ reference }) => reference));
      expect(claim.reviewChanges).toEqual([
        new Map([
          [
            stale.sessionId,
            {
              kind: "review",
              reason: { kind: "uncertain_keyless_refund" },
            },
          ],
        ]),
      ]);
    });

    test("keeps inherited work when another attendee blocks admission", async () => {
      const entries = candidateBatch("blocked_inherited").slice(0, 2);
      const [stale, reviewed] = entries;
      if (stale === undefined || reviewed === undefined) {
        throw new Error("No blocked inherited fixture");
      }
      const claim = grantingRowClaim(
        heldRows(entries),
        inheritedRows([stale], "keyless"),
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
      expect(claim.released).toEqual([[reviewed.sessionId]]);
    });

    test("keeps inherited work that cannot fit in the execution limit", async () => {
      const entries = candidateBatch("inherited_overflow");
      const claim = grantingRowClaim(
        heldRows(entries),
        inheritedRows(entries, "keyed"),
      );
      const source = provider();

      await processRefundBatchAt(
        source,
        entries.map(({ candidate }) => candidate),
        LISTING,
        { claim },
      );

      const executed = entries.slice(0, BULK_REFUND_LIMIT);
      expect(source.reads).toEqual(executed.map(({ reference }) => reference));
      expect(source.refunds).toEqual(
        executed.map(({ reference }) => reference),
      );
      expect(claim.released).toEqual([
        executed.map(({ sessionId }) => sessionId),
      ]);
    });
  },
);
