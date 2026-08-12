import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import { processRefundBatch } from "#routes/admin/refunds/provider.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import { armEveryRefund } from "./dispatch-helpers.ts";
import {
  candidateWithReferences,
  finishedCounts,
  observedReference,
  readyCandidateFrom,
} from "./helpers.ts";
import {
  HELD_SINCE,
  LISTING_ID,
  noValidatingProvider,
  type Prepare,
  readyPreparation,
  recordingProvider,
  recordingWrites,
  releasedRows,
  rowClaimHarness,
  taggedReference,
  untaggedReference,
} from "./readiness-helpers.ts";

describe("admin refund provider readiness integration", () => {
  const errors = setupErrorSpy();

  test("claims unresolved, passes exact facts, and releases a fresh unread claim", async () => {
    const reference = untaggedReference("same", "stored_same");
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
      return Promise.resolve(noValidatingProvider(reference));
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
      errors.contains(
        "No configured payment provider recognizes this payment. Add the provider it was taken with, or refund it from that provider's dashboard.",
      ),
    ).toBe(true);
  });

  test("reports a historical marker as repair-required without executing", async () => {
    const reference = untaggedReference("returned", "old", "completed");
    const batch = [candidateWithReferences([reference], 12)];
    const claim = rowClaimHarness({
      held: new Map([[12, reference.rowSessionIds]]),
    });
    const writes = recordingWrites();
    const prepare: Prepare = () =>
      Promise.resolve({
        indexes: [reference.index],
        kind: "not_ready",
        observations: [],
        reason: "historical_marker",
      });

    const counts = finishedCounts(
      await processRefundBatch(batch, LISTING_ID, {
        claim: claim.rowClaim,
        prepare,
        ...writes.dependencies,
      }),
    );

    expect(counts.failedCount).toBe(1);
    expect(writes.marked).toEqual([]);
    expect(writes.recorded).toEqual([]);
    expect(claim.settlements).toEqual([
      {
        commandId: "test-command",
        heldSince: HELD_SINCE,
        rows: new Map([
          [
            reference.rowSessionIds[0],
            {
              books: "unrecorded",
              claim: "release",
              phase: "checking",
            },
          ],
        ]),
      },
    ]);
    expect(
      errors.contains(
        "an older returned-payment marker needs its provider recorded before this refund can continue",
      ),
    ).toBe(true);
  });

  test("dispatches equal raw references by tagged index and reuses exact evidence", async () => {
    const stripe = recordingProvider("stripe");
    const square = recordingProvider("square");
    const sumup = recordingProvider("sumup", "keyless");
    const stripeCharge = chargeMoney(1100);
    const squareCharge = chargeMoney(2200);
    const stripeRef = taggedReference("stripe", "same_raw", "stripe_same");
    const squareRef = taggedReference("square", "same_raw", "square_same");
    const returnedRef = taggedReference("sumup", "same_raw", "sumup_same");
    const source = candidateWithReferences(
      [stripeRef, squareRef, returnedRef],
      21,
    );
    const claim = rowClaimHarness({
      held: new Map([
        [21, source.references.flatMap(({ rowSessionIds }) => rowSessionIds)],
      ]),
    });
    const writes = recordingWrites();

    const counts = finishedCounts(
      await processRefundBatch([source], LISTING_ID, {
        arm: armEveryRefund(),
        claim: claim.rowClaim,
        prepare: readyPreparation([
          readyCandidateFrom(source, [
            observedReference(stripeRef, stripe, stripeCharge),
            observedReference(squareRef, square, squareCharge),
            {
              kind: "already_returned",
              provider: sumup,
              reference: returnedRef,
            },
          ]),
        ]),
        ...writes.dependencies,
      }),
    );

    expect(stripe.requests).toHaveLength(1);
    expect(square.requests).toHaveLength(1);
    expect(sumup.requests).toEqual([]);
    expect(stripe.requests[0]?.paymentReference).toBe("same_raw");
    expect(square.requests[0]?.paymentReference).toBe("same_raw");
    expect(stripe.requests[0]?.charge).toBe(stripeCharge);
    expect(square.requests[0]?.charge).toBe(squareCharge);
    expect(writes.marked.flat().map(({ index }) => index)).toEqual([
      stripeRef.index,
      squareRef.index,
      returnedRef.index,
    ]);
    expect(counts.refundedCount).toBe(1);
  });
});
