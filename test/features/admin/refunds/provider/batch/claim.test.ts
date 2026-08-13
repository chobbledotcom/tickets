import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";
import {
  candidate,
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
import { chargeMoney } from "#test-utils/payment-state.ts";
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
  Array.from({ length: 2 }, (_, offset) => {
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
  },
);
