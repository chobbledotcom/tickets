import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import {
  candidateWithReferences,
  finishedCounts,
  observedReference,
  readyCandidateFrom,
} from "./helpers.ts";
import {
  HELD_SINCE,
  LISTING_ID,
  missingAtProvider,
  type Prepare,
  readyPreparation,
  recordingProvider,
  recordingWrites,
  releasedRows,
  rowClaimHarness,
  taggedReference,
} from "./readiness-helpers.ts";

describe("admin refund provider readiness integration", () => {
  const errors = setupErrorSpy();

  test("claims unread evidence, passes exact facts, and releases the row", async () => {
    const reference = taggedReference("stripe", "same", "stored_same");
    const batch = [candidateWithReferences([reference], 11)];
    const held = new Map([[11, reference.rowSessionIds]]);
    const returned = new Set(["returned_by_claim"]);
    const events: string[] = [];
    const claim = rowClaimHarness({ held, returned }, events);
    const writes = recordingWrites();
    let preparedBatch: readonly RefundCandidate[] | undefined;
    let preparedClaim: Parameters<Prepare>[1] | undefined;
    let preparedReturned: ReadonlySet<string> | undefined;
    const prepare: Prepare = (candidates, exactClaim, alreadyReturned) => {
      events.push("prepare");
      preparedBatch = candidates;
      preparedClaim = exactClaim;
      preparedReturned = alreadyReturned;
      return Promise.resolve(missingAtProvider(reference));
    };

    const counts = finishedCounts(
      await processRefundBatch(batch, LISTING_ID, {
        claim: claim.rowClaim,
        prepare,
        ...writes.dependencies,
      }),
    );

    expect(claim.claims()).toBe(1);
    expect(events).toEqual(["claim", "prepare", "settle"]);
    expect(preparedBatch).toEqual(batch);
    expect(preparedClaim?.held).toEqual(held);
    expect(preparedClaim?.commandId).toBe("test-command");
    expect(preparedClaim?.heldSince).toBe(HELD_SINCE);
    expect(preparedReturned).toEqual(returned);
    expect(releasedRows(claim.settlements)).toEqual([reference.rowSessionIds]);
    expect(counts.failedCount).toBe(1);
    expect(writes.marked).toEqual([]);
    expect(writes.recorded).toEqual([]);
    expect(
      errors.contains("Admin refund not started (provider_evidence)"),
    ).toBe(true);
  });

  test("keeps equal raw references distinct by provider without resending a return", async () => {
    const stripe = recordingProvider("stripe");
    const square = recordingProvider("square");
    const stripeCharge = chargeMoney(1100);
    const stripeRef = taggedReference("stripe", "same_raw", "stripe_same");
    const squareRef = {
      ...taggedReference("square", "same_raw", "square_same"),
      refundState: "completed" as const,
    };
    const source = candidateWithReferences([stripeRef, squareRef], 21);
    const claim = rowClaimHarness({
      held: new Map([
        [21, source.references.flatMap(({ rowSessionIds }) => rowSessionIds)],
      ]),
    });
    const writes = recordingWrites();

    const counts = finishedCounts(
      await processRefundBatch([source], LISTING_ID, {
        claim: claim.rowClaim,
        prepare: readyPreparation([
          readyCandidateFrom(source, [
            observedReference(stripeRef, stripe, stripeCharge),
            {
              kind: "already_returned",
              provider: square,
              reference: squareRef,
            },
          ]),
        ]),
        ...writes.dependencies,
      }),
    );

    expect(stripe.requests).toHaveLength(1);
    expect(square.requests).toEqual([]);
    expect(stripe.requests[0]?.paymentReference).toBe("same_raw");
    expect(stripe.requests[0]?.charge).toBe(stripeCharge);
    expect(
      writes.marked.flat().map(({ referenceIndex }) => referenceIndex),
    ).toEqual([
      `${stripeRef.provider}:${stripeRef.reference}`,
      `${squareRef.provider}:${squareRef.reference}`,
    ]);
    expect(counts.refundedCount).toBe(1);
  });
});
