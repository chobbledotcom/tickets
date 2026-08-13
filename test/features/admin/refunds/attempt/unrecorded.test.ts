import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import type { RefundAuthorityReceipt } from "#shared/provider-refunds.ts";
import {
  refundReadyCandidate,
  requestRecordedProviderRefund,
} from "#test/features/admin/refunds/provider/dispatch-helpers.ts";
import {
  candidate,
  finishedCounts,
  provider,
  readyCandidate,
  readyCandidateWithReferences,
} from "#test/features/admin/refunds/provider/helpers.ts";
import {
  recordEveryRefund,
  recordNoRefunds,
} from "#test/features/admin/refunds/provider/ledger-results.ts";
import { grantingRowClaim } from "#test-utils/refund-routes.ts";

describe("admin refund provider > local recording", () => {
  test("a provider rejection leaves no attendee-row doubt", async () => {
    const result = await refundReadyCandidate(
      readyCandidateWithReferences(
        ["pi_unanswered"],
        provider({ refundCapability: "keyless" }),
      ),
      7,
    );

    expect(result.outcome).toBe("failed");
  });

  test("a canonical completed charge needs no provider call", async () => {
    const source = provider({ refundCapability: "keyless" });
    const result = await refundReadyCandidate(
      readyCandidate(
        [{ kind: "already_returned", reference: "pi_already" }],
        source,
      ),
      7,
    );

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
      refundCapability: "keyless",
      refunded: new Set(refunds),
      throws: uncertain ? new Set(["pi_held"]) : new Set(),
    });
    const recordedAuthorities: RefundAuthorityReceipt[][] = [];
    const result = await processRefundBatch(
      [candidate([{ reference: "pi_held" }], 11)],
      7,
      {
        claim,
        prepare: () =>
          Promise.resolve({
            candidates: [readyCandidateWithReferences(["pi_held"], source, 11)],
            kind: "ready",
          }),
        record: posted ? recordEveryRefund : recordNoRefunds,
        recordAuthorities: (authorities) => {
          recordedAuthorities.push([...authorities]);
          return Promise.resolve();
        },
        request: requestRecordedProviderRefund,
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
