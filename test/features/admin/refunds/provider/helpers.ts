import { requiredMapValue, uniqueBy } from "#fp";
import type { MarkReturnedReferences } from "#routes/admin/refunds/attempt.ts";
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
  RefundReadinessRead,
} from "#routes/admin/refunds/readiness.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { ResolvedRefundCapability } from "#shared/payment/row-state.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { sessionReference } from "#test/shared/refund-ledger/helpers.ts";
import {
  acceptedRefund,
  chargeMoney,
  refundReference,
} from "#test-utils/payment-state.ts";

type Reference = { reference: string; refundState?: RefundState };

export type RecordingProvider = ReadyRefundProvider & {
  readCharge: (reference: string) => Promise<ProviderRead<ChargeMoney>>;
  reads: string[];
  refunds: string[];
  requests: RefundRequest[];
};

type UnreadableProvider = RecordingProvider & { sent: string[] };

type Marker = {
  mark: MarkReturnedReferences;
  marked: string[];
};

export const finishedCounts = (result: RefundBatchResult): RefundCounts => {
  if (result.kind === "blocked") {
    throw new Error(`Expected the refund batch to run (${result.reason})`);
  }
  return result.counts;
};

export const oneFailedRefundCounts: RefundCounts = {
  errorCount: 0,
  failedCount: 1,
  notRecordedCount: 0,
  pendingCount: 0,
  refundedCount: 0,
};

export const candidate = (
  references: Reference[],
  id = 42,
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(({ reference, refundState = "none" }) =>
    refundReference(reference, { refundState }),
  ),
});

type ReadyReferenceInput = {
  charge?: ChargeMoney;
  index?: string;
  kind?: ReadyRefundReference["kind"];
  provider?: RecordingProvider;
  reference: string;
};

export const readyReference = (
  input: ReadyReferenceInput,
  defaultProvider: RecordingProvider,
): ReadyRefundReference => {
  const source = input.provider ?? defaultProvider;
  const reference = {
    ...refundReference(input.reference),
    index: input.index ?? `index_of_${source.type}_${input.reference}`,
    kind: "tagged" as const,
    provider: source.type,
  };
  return input.kind === "already_returned"
    ? { kind: "already_returned", provider: source, reference }
    : {
        charge: input.charge ?? chargeMoney(),
        kind: "observed",
        provider: source,
        reference,
      };
};

export const readyCandidate = (
  references: ReadyReferenceInput[],
  source: RecordingProvider,
  id = 42,
): ReadyRefundCandidate => ({
  attendee: { id } as ReadyRefundCandidate["attendee"],
  references: references.map((reference) => readyReference(reference, source)),
});

export const readyCandidateWithReferences = (
  references: string[],
  source: RecordingProvider,
  id = 42,
): ReadyRefundCandidate =>
  readyCandidate(
    references.map((reference) => ({ reference })),
    source,
    id,
  );

type PreparedProviderReference =
  | { kind: "already_returned" }
  | { charge: ChargeMoney; kind: "observed" }
  | RefundReadinessRead;

const prepareProviderReference = async (
  reference: RefundPaymentReference,
  source: RecordingProvider,
  alreadyReturned: ReadonlySet<string>,
): Promise<PreparedProviderReference> => {
  if (
    reference.refundState === "completed" ||
    alreadyReturned.has(reference.index)
  ) {
    return { kind: "already_returned" };
  }
  const read = await source.readCharge(reference.reference);
  return read.status === "found"
    ? { charge: read.resource, kind: "observed" }
    : {
        evidence: {
          attempts: [{ provider: source.type, result: read }],
          reason: "no_validating_provider",
          reference: reference.reference,
          source: "untagged",
          status: "unresolved",
        },
        index: reference.index,
      };
};

const isReadinessFailure = (
  reference: PreparedProviderReference,
): reference is RefundReadinessRead => "evidence" in reference;

const readyReferenceFrom = (
  reference: RefundPaymentReference,
  prepared: Exclude<PreparedProviderReference, RefundReadinessRead>,
  source: RecordingProvider,
  attendeeId: number,
): ReadyRefundReference => {
  const tagged = {
    ...reference,
    index: `index_of_${source.type}_${reference.reference}`,
    kind: "tagged" as const,
    provider: source.type,
    rowSessionIds:
      reference.rowSessionIds.length === 0
        ? [anchorSessionId(attendeeId, reference.index)]
        : reference.rowSessionIds,
  };
  return prepared.kind === "already_returned"
    ? { kind: "already_returned", provider: source, reference: tagged }
    : {
        charge: prepared.charge,
        kind: "observed",
        provider: source,
        reference: tagged,
      };
};

export const prepareAtProvider =
  (source: RecordingProvider): NonNullable<RefundRunDependencies["prepare"]> =>
  async (candidates, _claim, alreadyReturned) => {
    const references = uniqueBy(
      (reference: RefundPaymentReference) => reference.index,
    )(candidates.flatMap((candidate) => candidate.references));
    const preparedReferences = await Promise.all(
      references.map(async (reference) => ({
        index: reference.index,
        prepared: await prepareProviderReference(
          reference,
          source,
          alreadyReturned,
        ),
      })),
    );
    const failures = preparedReferences
      .map(({ prepared }) => prepared)
      .filter(isReadinessFailure);
    const preparedByIndex = new Map(
      preparedReferences
        .filter(
          (
            entry,
          ): entry is typeof entry & {
            prepared: Exclude<PreparedProviderReference, RefundReadinessRead>;
          } => !isReadinessFailure(entry.prepared),
        )
        .map(({ index, prepared }) => [index, prepared]),
    );
    return failures.length > 0
      ? { kind: "not_ready", reads: failures, reason: "provider_evidence" }
      : {
          candidates: candidates.map((candidate) => ({
            attendee: candidate.attendee,
            references: candidate.references.map((reference) => {
              const prepared = requiredMapValue(
                preparedByIndex,
                reference.index,
                `Test readiness lost payment reference ${reference.index}`,
              );
              return readyReferenceFrom(
                reference,
                prepared,
                source,
                candidate.attendee.id,
              );
            }),
          })),
          capability: source.refundCapability,
          kind: "ready",
        };
  };

/** Run provider orchestration tests behind their explicit readiness fixture. */
export const processRefundBatchAt = (
  source: RecordingProvider,
  candidates: RefundCandidate[],
  listingId: number,
  dependencies: Omit<RefundRunDependencies, "prepare"> = {},
): Promise<RefundBatchResult> =>
  processRefundBatch(candidates, listingId, {
    ...dependencies,
    prepare: prepareAtProvider(source),
  });

export const completedRefund = (
  request: RefundRequest,
): Extract<RefundAttemptResult, { kind: "completed" }> => ({
  amount: request.charge.captured,
  kind: "completed",
  proof: { charge: request.charge, kind: "charge_observation" },
});

export const provider = ({
  accepted = new Set<string>(),
  refunded = new Set<string>(),
  throws = new Set<string>(),
  refundCapability = "keyed",
  paymentProvider = "stripe",
  read = () => Promise.resolve(chargeMoney()),
  refund,
}: {
  accepted?: Set<string>;
  refunded?: Set<string>;
  throws?: Set<string>;
  refundCapability?: ResolvedRefundCapability;
  paymentProvider?: PaymentProviderType;
  read?: (reference: string) => Promise<ChargeMoney | null>;
  refund?: (request: RefundRequest) => Promise<RefundAttemptResult>;
} = {}): RecordingProvider => {
  const reads: string[] = [];
  const refunds: string[] = [];
  const requests: RefundRequest[] = [];
  return {
    readCharge: async (reference: string) => {
      reads.push(reference);
      const charge = await read(reference);
      return charge === null
        ? ({ reason: "network_error", status: "unavailable" } as const)
        : ({ resource: charge, status: "found" } as const);
    },
    reads,
    refundCapability,
    refundCharge: (request: RefundRequest) => {
      requests.push(request);
      refunds.push(request.paymentReference);
      if (refund !== undefined) return refund(request);
      if (throws.has(request.paymentReference)) {
        return Promise.resolve<RefundAttemptResult>({
          kind: "uncertain",
          reason: "network_error",
        });
      }
      return Promise.resolve<RefundAttemptResult>(
        accepted.has(request.paymentReference)
          ? acceptedRefund(request.charge)
          : refunded.has(request.paymentReference)
            ? completedRefund(request)
            : { kind: "rejected", reason: "failed" },
      );
    },
    refunds,
    requests,
    type: paymentProvider,
  };
};

export const unreadableProvider = (
  refundCapability: ResolvedRefundCapability,
): UnreadableProvider => {
  const source = provider({
    read: () => Promise.resolve(null),
    refundCapability,
  });
  return { ...source, sent: source.refunds };
};

export const collectingMarker = (): Marker => {
  const marked: string[] = [];
  return {
    mark: (references: readonly RefundPaymentReference[]) => {
      marked.push(...references.map((reference) => reference.reference));
      return Promise.resolve();
    },
    marked,
  };
};

export const throwMarker = (): never => {
  throw new Error("marker write failed");
};

export const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, index) => ({
      reference: `${id}${index}`,
    })),
  );

export const holdingClaim = (
  settle: RowClaim["settle"],
  sessions: readonly string[],
): RowClaim => ({
  claim: () =>
    Promise.resolve({
      held: new Map([[11, sessions]]),
      heldSince: "2026-08-10T12:00:00.000Z",
      inherited: new Map(),
      kind: "claimed",
      returned: new Set<string>(),
      reviews: new Map(),
      shared: new Map(),
      unrecorded: new Map(),
    }),
  settle,
});

export const refundedCandidate = (
  attendeeId: number,
  sessionId: string,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [sessionReference(sessionId)],
});

export const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) =>
    refundReference(reference, { sessionIds: [] }),
  ),
});

/** Provider that rejects each refund except named uncertain answers. */
export const failingProvider = (
  uncertain: Set<string>,
  refundCapability: ResolvedRefundCapability = "keyed",
): RecordingProvider => ({
  readCharge: () =>
    Promise.resolve({ resource: chargeMoney(), status: "found" } as const),
  reads: [],
  refundCapability,
  refundCharge: ({ paymentReference }: RefundRequest) =>
    Promise.resolve<RefundAttemptResult>(
      uncertain.has(paymentReference)
        ? { kind: "uncertain", reason: "network_error" }
        : { kind: "rejected", reason: "failed" },
    ),
  refunds: [],
  requests: [],
  type: "stripe",
});
