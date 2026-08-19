import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import type { ReadyRefundCandidate } from "#routes/admin/refunds/readiness.ts";
import {
  type RefundAuthorityReceipt,
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { refundReadyCandidate } from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidateWithReferences,
  finishedCounts,
  provider,
  readyCandidate,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  recordEveryRefund,
  recordNoRefunds,
} from "#test/features/admin/refunds/provider/ledger-results.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { markProviderRefundsReturned } from "#test-utils/payment-references.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

const oneCanonicalCandidate = async (
  input: Parameters<typeof readyCandidate>[0][number],
  source: Parameters<typeof readyCandidate>[1],
  attendeeId = 42,
): Promise<ReadyRefundCandidate> => {
  const candidate = readyCandidate([input], source, attendeeId);
  const ready = candidate.references[0]!;
  const index = await paymentReferenceIndex(ready.reference);
  return {
    ...candidate,
    references: [
      {
        ...ready,
        reference: { ...ready.reference, index, matchingIndexes: [index] },
      },
    ],
  };
};

describeWithEnv("admin refund provider > local recording", { db: true }, () => {
  test("a provider rejection leaves no attendee-row doubt", async () => {
    const source = provider({
      paymentProvider: "sumup",
      refundCapability: "keyless",
    });
    const result = await refundReadyCandidate(
      await oneCanonicalCandidate({ reference: "pi_unanswered" }, source),
      7,
    );

    expect(result.outcome).toBe("failed");
  });

  test("a canonical completed charge needs no provider call", async () => {
    const source = provider({
      paymentProvider: "sumup",
      refundCapability: "keyless",
    });
    const candidate = await oneCanonicalCandidate(
      { kind: "already_returned", reference: "pi_already" },
      source,
    );
    await markProviderRefundsReturned([candidate.references[0]!.reference]);
    const result = await refundReadyCandidate(candidate, 7);

    expect(source.refunds).toEqual([]);
    expect(result).toMatchObject({ outcome: "refunded" });
  });

  const run = async (
    posted: boolean,
    refunds = ["pi_held"],
    uncertain = false,
  ) => {
    const claim = grantingRowClaim(new Map([[11, ["sess_pi_held"]]]));
    const source = provider({
      paymentProvider: "sumup",
      refundCapability: "keyless",
      refunded: new Set(refunds),
      throws: uncertain ? new Set(["pi_held"]) : new Set(),
    });
    const ready = await oneCanonicalCandidate(
      { reference: "pi_held" },
      source,
      11,
    );
    const reference = ready.references[0]!.reference;
    const recordedAuthorities: RefundAuthorityReceipt[][] = [];
    const result = await processRefundBatch(
      [candidateWithReferences([reference], 11)],
      7,
      {
        claim,
        prepare: () =>
          Promise.resolve({
            candidates: [ready],
            kind: "ready",
          }),
        record: posted ? recordEveryRefund : recordNoRefunds,
        recordAuthorities: async (authorities) => {
          recordedAuthorities.push([...authorities]);
          await recordProviderRefunds(authorities);
        },
        request: requestProviderRefund,
      },
    );
    return { claim, recordedAuthorities, result };
  };

  test("pending provider work releases the attendee fence", async () => {
    const { claim, recordedAuthorities } = await run(true, [], true);

    expect(claim.released).toEqual([["sess_pi_held"]]);
    expect(recordedAuthorities).toEqual([[]]);
  });

  test("a posted return retires its durable local obligation", async () => {
    const { claim, recordedAuthorities, result } = await run(true);

    expect(finishedCounts(result).refundedCount).toBe(1);
    expect(claim.released).toEqual([["sess_pi_held"]]);
    expect(recordedAuthorities[0]).toHaveLength(1);
  });

  test("a missed ledger post preserves the row marker and authority", async () => {
    const { claim, recordedAuthorities, result } = await run(false);

    expect(finishedCounts(result).notRecordedCount).toBe(1);
    expect(claim.released).toEqual([["sess_pi_held"]]);
    expect(claim.unrecorded).toEqual([["sess_pi_held"]]);
    expect(recordedAuthorities).toEqual([[]]);
  });
});
