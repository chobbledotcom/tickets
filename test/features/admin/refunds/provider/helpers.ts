import { requiredMapValue, uniqueBy } from "#fp";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
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
  RefundReadinessObservation,
  RefundReadinessRead,
} from "#routes/admin/refunds/readiness.ts";
import type { TaggedRefundPaymentReference } from "#shared/db/payment-references.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#shared/payment/refund-provider-authorization.ts";
import type { RefundProviderCapability } from "#shared/payment/refund-provider-authorization.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { requestRecordedProviderRefund } from "./dispatch-helpers.ts";
import {
  acceptedRefund,
  chargeMoney,
  refundReference,
} from "#test-utils/payment-state.ts";

type Reference = {
  provider?: PaymentProviderType;
  reference: string;
  refundState?: RefundState;
};
export type RecordingProvider = ReadyRefundProvider & {
  answerRefund: (request: RefundRequest) => Promise<RefundAttemptResult>;
  readCharge: (reference: string) => Promise<ProviderRead<ChargeMoney>>;
  reads: string[];
  refunds: string[];
  requests: RefundRequest[];
};
export const finishedCounts = (result: RefundBatchResult): RefundCounts => {
  if (result.kind === "blocked") {
    throw new Error(`Expected the refund batch to run (${result.reason})`);
  }
  return result.counts;
};

const taggedReference = (
  reference: string,
  provider: PaymentProviderType,
  values: Partial<
    Omit<
      TaggedRefundPaymentReference,
      "kind" | "provider" | "reference"
    >
  > = {},
): TaggedRefundPaymentReference => {
  const stored = refundReference(reference, values);
  const index = values.index ?? `index_of_${provider}_${reference}`;
  return {
    ...stored,
    ...values,
    index,
    kind: "tagged",
    matchingIndexes: values.matchingIndexes ?? [index],
    provider,
  };
};

export const candidate = (
  references: Reference[],
  id = 42,
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(
    ({ provider = "stripe", reference, refundState = "none" }) =>
      taggedReference(reference, provider, { refundState }),
  ),
});

export const candidateWithReferences = (
  references: TaggedRefundPaymentReference[],
  id = 42,
): RefundCandidate => ({ ...candidate([], id), references });
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
  const reference = taggedReference(input.reference, source.type, {
    index: input.index ?? `index_of_${source.type}_${input.reference}`,
  });
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

export const readyCandidateFrom = (
  source: RefundCandidate,
  references: ReadyRefundReference[],
): ReadyRefundCandidate => ({ attendee: source.attendee, references });

export const observedReference = (
  reference: TaggedRefundPaymentReference,
  source: RecordingProvider,
  charge: ChargeMoney = chargeMoney(),
): ReadyRefundReference => ({
  charge,
  kind: "observed",
  provider: source,
  reference,
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
  reference: TaggedRefundPaymentReference,
  source: RecordingProvider,
  alreadyReturned: ReadonlySet<string>,
): Promise<PreparedProviderReference> => {
  if (reference.provider !== source.type) {
    throw new Error(
      `Test readiness received ${reference.provider} payment at ${source.type}`,
    );
  }
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
        ...read,
        provider: source.type,
        reference: reference.reference,
      },
      index: reference.index,
    };
};

const isReadinessFailure = (
  reference: PreparedProviderReference,
): reference is RefundReadinessRead => "evidence" in reference;

const preparationObservations = (
  prepared: PreparedProviderReference,
  reference: TaggedRefundPaymentReference,
  source: RecordingProvider,
): RefundReadinessObservation[] => {
  if (isReadinessFailure(prepared) || prepared.kind === "already_returned") {
    return [];
  }
  return [{
    charge: prepared.charge,
    identity: {
      kind: "tagged",
      provider: source.type,
      reference: reference.reference,
    },
    reference,
  }];
};

const readyReferenceFrom = (
  reference: TaggedRefundPaymentReference,
  prepared: Exclude<PreparedProviderReference, RefundReadinessRead>,
  source: RecordingProvider,
): ReadyRefundReference => {
  return prepared.kind === "already_returned"
    ? { kind: "already_returned", provider: source, reference }
    : {
      charge: prepared.charge,
      kind: "observed",
      provider: source,
      reference,
    };
};

export const prepareAtProvider =
  (source: RecordingProvider): NonNullable<RefundRunDependencies["prepare"]> =>
  async (candidates, _claim, alreadyReturned) => {
    const references = uniqueBy(
      (reference: TaggedRefundPaymentReference) => reference.index,
    )(candidates.flatMap((candidate) => candidate.references));
    const preparedReferences = await Promise.all(
      references.map(async (reference) => ({
        prepared: await prepareProviderReference(
          reference,
          source,
          alreadyReturned,
        ),
        reference,
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
        .map(({ reference, prepared }) => [reference.index, prepared]),
    );
    return failures.length > 0
      ? {
        kind: "not_ready",
        observations: preparedReferences.flatMap(({ prepared, reference }) =>
          preparationObservations(prepared, reference, source)
        ),
        reads: failures,
        reason: "provider_evidence",
      }
      : {
        candidates: candidates.map((candidate) => ({
          attendee: candidate.attendee,
          references: candidate.references.map((reference) => {
            const prepared = requiredMapValue(
              preparedByIndex,
              reference.index,
              `Test readiness lost payment reference ${reference.index}`,
            );
            return readyReferenceFrom(reference, prepared, source);
          }),
        })),
        kind: "ready",
      };
  };

export const processRefundBatchAt = (
  source: RecordingProvider,
  candidates: RefundCandidate[],
  listingId: number,
  dependencies: Omit<RefundRunDependencies, "prepare"> = {},
): Promise<RefundBatchResult> =>
  processRefundBatch(candidates, listingId, {
    ...dependencies,
    prepare: prepareAtProvider(source),
    recordAuthorities: dependencies.recordAuthorities ??
      (() => Promise.resolve()),
    request: dependencies.request ?? requestRecordedProviderRefund,
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
  refundCapability?: RefundProviderCapability;
  paymentProvider?: PaymentProviderType;
  read?: (reference: string) => Promise<ChargeMoney | null>;
  refund?: (request: RefundRequest) => Promise<RefundAttemptResult>;
} = {}): RecordingProvider => {
  const reads: string[] = [];
  const refunds: string[] = [];
  const requests: RefundRequest[] = [];
  const answerRefund = (
    request: RefundRequest,
  ): Promise<RefundAttemptResult> => {
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
  };
  return {
    answerRefund,
    readCharge: async (reference: string) => {
      reads.push(reference);
      const charge = await read(reference);
      return charge === null
        ? ({ reason: "network_error", status: "unavailable" } as const)
        : ({ resource: charge, status: "found" } as const);
    },
    reads,
    refundCapability,
    refundCharge: (request: AuthorizedRefundRequest) => answerRefund(request),
    refunds,
    requests,
    type: paymentProvider,
  };
};

export const unreadableProvider = (
  refundCapability: RefundProviderCapability,
): RecordingProvider =>
  provider({
    read: () => Promise.resolve(null),
    refundCapability,
  });

export const rowBackedReference = (
  reference: string,
  sessionId: string,
  refundState: RefundState = "none",
): TaggedRefundPaymentReference =>
  taggedReference(reference, "stripe", {
    refundState,
    rowSessionIds: [sessionId],
    sessionIds: [sessionId],
  });

export const rowBackedCandidate = (
  attendeeId: number,
  sessionId: string,
  reference = `pi_${sessionId}`,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [rowBackedReference(reference, sessionId)],
});

export const refs = (id: string, count: number): RefundCandidate =>
  candidate(
    Array.from({ length: count }, (_, index) => ({
      reference: `${id}${index}`,
    })),
  );

export const refundedCandidate = (
  attendeeId: number,
  sessionId: string,
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [rowBackedReference(`pi-${sessionId}`, sessionId, "completed")],
});

export const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) =>
    taggedReference(reference, "stripe", { sessionIds: [] })
  ),
});

/** Provider that rejects each refund except named uncertain answers. */
export const failingProvider = (
  uncertain: Set<string>,
  refundCapability: RefundProviderCapability = "keyed",
): RecordingProvider => {
  const answerRefund = ({ paymentReference }: RefundRequest) =>
    Promise.resolve<RefundAttemptResult>(
      uncertain.has(paymentReference)
        ? { kind: "uncertain", reason: "network_error" }
        : { kind: "rejected", reason: "failed" },
    );
  return {
    answerRefund,
    readCharge: () =>
      Promise.resolve({ resource: chargeMoney(), status: "found" } as const),
    reads: [],
    refundCapability,
    refundCharge: (request: AuthorizedRefundRequest) => answerRefund(request),
    refunds: [],
    requests: [],
    type: "stripe",
  };
};
