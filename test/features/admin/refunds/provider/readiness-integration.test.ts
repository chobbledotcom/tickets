import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import {
  processRefundBatch,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import type {
  ReadyRefundCandidate,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { RefundProviderCapability } from "#shared/payment/row-state.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney, completedRefund } from "#test-utils/payment-state.ts";
import { armEveryRefund } from "./dispatch-helpers.ts";
import {
  candidateWithReferences,
  finishedCounts,
  observedReference,
  provider,
  type RecordingProvider,
  readyCandidateFrom,
} from "./helpers.ts";
import { recordEveryRefund } from "./ledger-results.ts";

const LISTING_ID = 7;
const HELD_SINCE = "2026-08-11T12:00:00.000Z";

type Prepare = NonNullable<RefundRunDependencies["prepare"]>;
type Claimed = Extract<
  Awaited<ReturnType<RowClaim["claim"]>>,
  { kind: "claimed" }
>;
type TaggedReference = Extract<RefundPaymentReference, { kind: "tagged" }>;
type UntaggedReference = Extract<RefundPaymentReference, { kind: "untagged" }>;
const recordingProvider = (
  type: PaymentProviderType,
  refundCapability: RefundProviderCapability = "keyed",
): RecordingProvider =>
  provider({
    paymentProvider: type,
    refund: (request) => Promise.resolve(completedRefund(request.charge)),
    refundCapability,
  });

const taggedReference = (
  provider: PaymentProviderType,
  reference: string,
  index: string,
  sessionId = `session_${index}`,
): TaggedReference => ({
  heldRowSessionIds: [],
  index,
  kind: "tagged",
  matchingIndexes: [index],
  provider,
  reference,
  refundState: "none",
  rowSessionIds: [sessionId],
  sessionIds: [sessionId],
});

const untaggedReference = (
  raw: string,
  key: string,
  state: UntaggedReference["refundState"] = "none",
): UntaggedReference => {
  const { provider: _provider, ...facts } = taggedReference("stripe", raw, key);
  return { ...facts, kind: "untagged", refundState: state };
};

const readyPreparation =
  (candidates: ReadyRefundCandidate[]): Prepare =>
  () =>
    Promise.resolve({ candidates, kind: "ready" });

const noValidatingProvider = (
  reference: RefundPaymentReference,
): RefundReadinessResult => ({
  kind: "not_ready",
  reads: [
    {
      evidence: {
        attempts: [{ provider: "stripe", result: { status: "missing" } }],
        reason: "no_validating_provider",
        reference: reference.reference,
        source: "untagged",
        status: "unresolved",
      },
      index: reference.index,
    },
  ],
  reason: "provider_evidence",
});

const rowClaimHarness = (
  {
    held,
    inherited = new Map(),
    returned = new Set(),
    shared = new Map(),
  }: Pick<Claimed, "held"> &
    Partial<Pick<Claimed, "inherited" | "returned" | "shared">>,
  events: string[] = [],
) => {
  let claims = 0;
  const settlements: RowSettlement[] = [];
  return {
    claims: () => claims,
    rowClaim: {
      claim: () => {
        events.push("claim");
        claims++;
        return Promise.resolve({
          commandId: "test-command",
          held,
          heldSince: HELD_SINCE,
          inherited,
          kind: "claimed",
          phases: new Map(
            [...held].flatMap(([attendeeId, sessionIds]) =>
              sessionIds.map(
                (sessionId) =>
                  [
                    sessionId,
                    inherited.has(attendeeId) ? "send_armed" : "checking",
                  ] as const,
              ),
            ),
          ),
          returned,
          reviews: new Map(),
          shared,
          unrecorded: new Map(),
        });
      },
      settle: (settlement) => {
        events.push("settle");
        settlements.push(settlement);
        return Promise.resolve();
      },
    } satisfies RowClaim,
    settlements,
  };
};

const releasedRows = (settlements: readonly RowSettlement[]): string[][] =>
  settlements.map(({ rows }) =>
    [...rows]
      .filter(([, change]) => change.claim === "release")
      .map(([sessionId]) => sessionId),
  );

const recordingWrites = (): {
  dependencies: Pick<RefundRunDependencies, "markReturned" | "record">;
  marked: TaggedReference[][];
  recorded: number[][];
} => {
  const marked: TaggedReference[][] = [];
  const recorded: number[][] = [];
  return {
    dependencies: {
      markReturned: (references) => {
        marked.push([...references]);
        return Promise.resolve();
      },
      record: (postings) => {
        recorded.push(postings.map(({ attendeeId }) => attendeeId));
        return recordEveryRefund(postings);
      },
    },
    marked,
    recorded,
  };
};

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

  test("turns exact inherited keyless indexes into owner review", async () => {
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
    ).toEqual(["collision"]);
    expect(counts.failedCount).toBe(2);
    expect(counts.refundedCount).toBe(1);
    expect(writes.marked.flat().map(({ index }) => index)).toEqual([
      stripeRef.index,
    ]);
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
