import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import {
  processRefundBatch,
  type RefundBatchResult,
  type RefundCounts,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import type {
  ReadyRefundCandidate,
  ReadyRefundProvider,
  ReadyRefundReference,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { RefundRequest } from "#shared/payment/refund-attempt.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type {
  RefundCapability,
  ResolvedRefundCapability,
} from "#shared/payment/row-state.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { chargeMoney, completedRefund } from "#test-utils/payment-state.ts";
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

type RecordingProvider = ReadyRefundProvider & {
  readonly requests: RefundRequest[];
};

const recordingProvider = (
  type: PaymentProviderType,
  refundCapability: ResolvedRefundCapability = "keyed",
): RecordingProvider => {
  const requests: RefundRequest[] = [];
  return {
    refundCapability,
    refundCharge: (request) => {
      requests.push(request);
      return Promise.resolve(completedRefund(request.charge));
    },
    requests,
    type,
  };
};

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

const candidate = (
  id: number,
  references: RefundPaymentReference[],
): RefundCandidate => ({
  attendee: { id, pii_blob: "" } as RefundCandidate["attendee"],
  references,
});

const observed = (
  reference: TaggedReference,
  provider: RecordingProvider,
  charge: ChargeMoney = chargeMoney(),
): ReadyRefundReference => ({
  charge,
  kind: "observed",
  provider,
  reference,
});

const readyCandidate = (
  source: RefundCandidate,
  references: ReadyRefundReference[],
): ReadyRefundCandidate => ({ attendee: source.attendee, references });

const readyPreparation =
  (
    candidates: ReadyRefundCandidate[],
    capability: ResolvedRefundCapability = "keyed",
  ): Prepare =>
  () =>
    Promise.resolve({ candidates, capability, kind: "ready" });

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
  const capabilities: RefundCapability[] = [];
  const settlements: RowSettlement[] = [];
  return {
    capabilities,
    rowClaim: {
      claim: (_attendees, capability) => {
        events.push("claim");
        capabilities.push(capability);
        return Promise.resolve({
          held,
          heldSince: HELD_SINCE,
          inherited,
          kind: "claimed",
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

const finishedCounts = (result: RefundBatchResult): RefundCounts => {
  if (result.kind === "blocked") {
    throw new Error(`Expected a finished refund, got ${result.reason}`);
  }
  return result.counts;
};

describe("admin refund provider readiness integration", () => {
  const errors = setupErrorSpy();

  test("claims unresolved, passes exact facts, and releases a fresh unread claim", async () => {
    const reference = untaggedReference("same", "stored_same");
    const batch = [candidate(11, [reference])];
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

    expect(claim.capabilities).toEqual(["unresolved"]);
    expect(events).toEqual(["claim", "prepare", "settle"]);
    expect(preparedBatch).toBe(batch);
    expect(preparedClaim?.held).toBe(held);
    expect(preparedClaim?.heldSince).toBe(HELD_SINCE);
    expect(preparedReturned).toBe(returned);
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
    const batch = [candidate(12, [reference])];
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
    const source = candidate(21, [stripeRef, squareRef, returnedRef]);
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
          readyCandidate(source, [
            observed(stripeRef, stripe, stripeCharge),
            observed(squareRef, square, squareCharge),
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

  test("scopes inherited keyless observation to each rebound index", async () => {
    const sumup = recordingProvider("sumup", "keyless");
    const stripe = recordingProvider("stripe");
    const staleRef = taggedReference("sumup", "collision", "s", "row_1");
    const sharingRef = taggedReference("sumup", "collision", "s", "row_2");
    const stripeRef = taggedReference("stripe", "collision", "t", "row_3");
    const stale = candidate(31, [staleRef]);
    const sharing = candidate(32, [sharingRef]);
    const independent = candidate(33, [stripeRef]);
    const claim = rowClaimHarness({
      held: new Map([
        [31, staleRef.rowSessionIds],
        [32, sharingRef.rowSessionIds],
        [33, stripeRef.rowSessionIds],
      ]),
      inherited: new Map([[31, "keyless"]]),
    });
    const writes = recordingWrites();

    const counts = finishedCounts(
      await processRefundBatch([stale, sharing, independent], LISTING_ID, {
        claim: claim.rowClaim,
        prepare: readyPreparation(
          [
            readyCandidate(stale, [observed(staleRef, sumup)]),
            readyCandidate(sharing, [observed(sharingRef, sumup)]),
            readyCandidate(independent, [observed(stripeRef, stripe)]),
          ],
          "keyless",
        ),
        ...writes.dependencies,
      }),
    );

    expect(sumup.requests).toEqual([]);
    expect(
      stripe.requests.map(({ paymentReference }) => paymentReference),
    ).toEqual(["collision"]);
    expect(counts.pendingCount).toBe(2);
    expect(counts.refundedCount).toBe(1);
    expect(writes.marked.flat().map(({ index }) => index)).toEqual([
      stripeRef.index,
    ]);
    expect(releasedRows(claim.settlements)).toEqual([["row_3"]]);
  });

  test("retains an inherited claim when readiness cannot prove its charge", async () => {
    const reference = taggedReference("sumup", "unread", "unread_ref", "row_4");
    const batch = [candidate(41, [reference])];
    const claim = rowClaimHarness({
      held: new Map([[41, reference.rowSessionIds]]),
      inherited: new Map([[41, "keyless"]]),
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
