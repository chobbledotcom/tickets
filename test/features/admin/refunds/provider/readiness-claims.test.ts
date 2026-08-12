import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { armEveryRefund } from "./dispatch-helpers.ts";
import {
  candidateWithReferences,
  finishedCounts,
  observedReference,
  readyCandidateFrom,
} from "./helpers.ts";
import {
  LISTING_ID,
  noValidatingProvider,
  readyPreparation,
  recordingProvider,
  recordingWrites,
  releasedRows,
  rowClaimHarness,
  taggedReference,
} from "./readiness-helpers.ts";

describe("admin refund provider readiness claims", () => {
  test("stands an exact batch down when an inherited keyless index needs review", async () => {
    const sumup = recordingProvider("sumup", "keyless");
    const stripe = recordingProvider("stripe");
    const staleRef = taggedReference("sumup", "collision", "s", "row_1");
    const sharingRef = taggedReference("sumup", "collision", "s", "row_2");
    const stripeRef = taggedReference("stripe", "collision", "t", "row_3");
    const stale = candidateWithReferences([staleRef], 31);
    const sharing = candidateWithReferences([sharingRef], 32);
    const independent = candidateWithReferences([stripeRef], 33);
    const claim = rowClaimHarness({
      held: new Map([
        [31, staleRef.rowSessionIds],
        [32, sharingRef.rowSessionIds],
        [33, stripeRef.rowSessionIds],
      ]),
      inherited: new Map([[31, new Map([[staleRef.index, "keyless"]])]]),
    });
    const writes = recordingWrites();

    const counts = finishedCounts(
      await processRefundBatch([stale, sharing, independent], LISTING_ID, {
        arm: async (request) =>
          request.indexes.includes(staleRef.index)
            ? {
                indexes: [staleRef.index],
                kind: "owner_review",
                reason: "uncertain_keyless_refund",
              }
            : await armEveryRefund()(request),
        claim: claim.rowClaim,
        prepare: readyPreparation([
          readyCandidateFrom(stale, [observedReference(staleRef, sumup)]),
          readyCandidateFrom(sharing, [observedReference(sharingRef, sumup)]),
          readyCandidateFrom(independent, [
            observedReference(stripeRef, stripe),
          ]),
        ]),
        ...writes.dependencies,
      }),
    );

    expect(sumup.requests).toEqual([]);
    expect(
      stripe.requests.map(({ paymentReference }) => paymentReference),
    ).toEqual([]);
    expect(counts.failedCount).toBe(3);
    expect(counts.refundedCount).toBe(0);
    expect(writes.marked).toEqual([]);
    expect(releasedRows(claim.settlements)).toEqual([
      ["row_1", "row_2", "row_3"],
    ]);
  });

  test("retains an inherited claim when readiness cannot prove its charge", async () => {
    const reference = taggedReference("sumup", "unread", "unread_ref", "row_4");
    const batch = [candidateWithReferences([reference], 41)];
    const claim = rowClaimHarness({
      held: new Map([[41, reference.rowSessionIds]]),
      inherited: new Map([[41, new Map([[reference.index, "keyless"]])]]),
    });
    const writes = recordingWrites();

    await processRefundBatch(batch, LISTING_ID, {
      claim: claim.rowClaim,
      prepare: () => Promise.resolve(noValidatingProvider(reference)),
      ...writes.dependencies,
    });

    expect(claim.settlements).toEqual([]);
    expect(writes.marked).toEqual([]);
    expect(writes.recorded).toEqual([]);
  });
});
