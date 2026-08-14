import type { RowClaim } from "#routes/admin/refunds/claim.ts";
import type { RefundRunDependencies } from "#routes/admin/refunds/provider.ts";
import type {
  ReadyRefundCandidate,
  RefundReadinessResult,
} from "#routes/admin/refunds/readiness.ts";
import type { RowSettlement } from "#shared/db/payment-claim.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { RefundProviderCapability } from "#shared/payment/refund-provider-authorization.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { completedRefund } from "#test-utils/payment-state.ts";
import { requestRecordedProviderRefund } from "./dispatch-helpers.ts";
import { provider, type RecordingProvider } from "./helpers.ts";
import { recordEveryRefund } from "./ledger-results.ts";

export const LISTING_ID = 7;
export const HELD_SINCE = "2026-08-11T12:00:00.000Z";

export type Prepare = NonNullable<RefundRunDependencies["prepare"]>;
type Claimed = Extract<
  Awaited<ReturnType<RowClaim["claim"]>>,
  { kind: "claimed" }
>;
export type TaggedReference = Extract<
  RefundPaymentReference,
  { kind: "tagged" }
>;

export const recordingProvider = (
  type: PaymentProviderType,
  refundCapability: RefundProviderCapability = "keyed",
): RecordingProvider =>
  provider({
    paymentProvider: type,
    refund: (request) => Promise.resolve(completedRefund(request.charge)),
    refundCapability,
  });

export const taggedReference = (
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

export const readyPreparation =
  (candidates: ReadyRefundCandidate[]): Prepare =>
  () =>
    Promise.resolve({ candidates, kind: "ready" });

export const missingAtProvider = (
  reference: TaggedReference,
): RefundReadinessResult => ({
  kind: "not_ready",
  observations: [],
  reads: [
    {
      evidence: {
        provider: reference.provider,
        reference: reference.reference,
        status: "missing",
      },
      index: reference.index,
    },
  ],
  reason: "provider_evidence",
});

type ClaimFacts = Pick<Claimed, "held"> &
  Partial<Pick<Claimed, "returned" | "shared">>;

interface RowClaimHarness {
  claims: () => number;
  rowClaim: RowClaim;
  settlements: RowSettlement[];
}

export const rowClaimHarness = (
  { held, returned = new Set(), shared = new Map() }: ClaimFacts,
  events: string[] = [],
): RowClaimHarness => {
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
          kind: "claimed",
          phases: new Map(
            [...held.values()].flatMap((sessionIds) =>
              sessionIds.map((sessionId) => [sessionId, "checking"] as const),
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
    },
    settlements,
  };
};

export const releasedRows = (
  settlements: readonly RowSettlement[],
): string[][] =>
  settlements.map(({ rows }) =>
    [...rows]
      .filter(([, change]) => change.claim === "release")
      .map(([sessionId]) => sessionId),
  );

interface RecordingWrites {
  dependencies: Pick<
    RefundRunDependencies,
    "record" | "recordAuthorities" | "request"
  >;
  marked: { readonly referenceIndex: string }[][];
  recorded: number[][];
}

export const recordingWrites = (): RecordingWrites => {
  const marked: { readonly referenceIndex: string }[][] = [];
  const recorded: number[][] = [];
  return {
    dependencies: {
      record: (postings) => {
        recorded.push(postings.map(({ attendeeId }) => attendeeId));
        return recordEveryRefund(postings);
      },
      recordAuthorities: (authorities) => {
        marked.push([...authorities]);
        return Promise.resolve();
      },
      request: requestRecordedProviderRefund,
    },
    marked,
    recorded,
  };
};
