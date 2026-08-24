import { assert } from "@std/assert";
import type { TaggedRefundPaymentReference } from "#db/payment-references.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  requireProviderRefundAuthorization,
} from "#payment/refund-provider-authorization.ts";
import type { RefundState } from "#payment/refund-state.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import {
  processRefundBatch,
  type RefundBatchResult,
  type RefundCounts,
  type RefundRunDependencies,
} from "#routes/admin/refunds/provider.ts";
import {
  prepareRefundReadiness,
  type ReadyRefundCandidate,
  type ReadyRefundReference,
} from "#routes/admin/refunds/readiness.ts";
import type { RefundProviderCapability } from "#shared/payment-providers.ts";
import type { RefundEngineProvider } from "#shared/provider-refunds.ts";
import {
  acceptedRefund,
  chargeMoney,
  taggedRefundReference,
} from "#test-utils/payment-state.ts";
import type { PaymentProviderType } from "#types";

type Reference = {
  provider?: PaymentProviderType;
  reference: string;
  refundState?: RefundState;
};
export type RecordingProvider = RefundEngineProvider & {
  readCharge: (reference: string) => Promise<ProviderRead<ChargeMoney>>;
  reads: string[];
  refunds: string[];
  requests: RefundRequest[];
};
export const finishedCounts = (result: RefundBatchResult): RefundCounts => {
  assert("counts" in result, "Expected the refund batch to run");
  return result.counts;
};

export const candidate = (
  references: Reference[],
  id = 42,
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references: references.map(
    ({ provider = "stripe", reference, refundState = "none" }) =>
      taggedRefundReference(reference, provider, {
        index: `index_of_${provider}_${reference}`,
        matchingIndexes: [`index_of_${provider}_${reference}`],
        refundState,
      }),
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
  const reference = taggedRefundReference(input.reference, source.type, {
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

export const prepareAtProvider =
  (source: RecordingProvider): NonNullable<RefundRunDependencies["prepare"]> =>
  (candidates, claim, alreadyReturned) =>
    prepareRefundReadiness(candidates, claim, alreadyReturned, {
      loadProvider: ({ provider }) => {
        assert(
          provider === source.type,
          `Test readiness received ${provider} payment at ${source.type}`,
        );
        return Promise.resolve(source);
      },
    });

export const processRefundBatchAt = (
  source: RecordingProvider,
  candidates: RefundCandidate[],
  listingId: number,
  dependencies: Omit<RefundRunDependencies, "prepare"> = {},
): Promise<RefundBatchResult> =>
  processRefundBatch(candidates, listingId, {
    ...dependencies,
    prepare: prepareAtProvider(source),
    recordAuthorities:
      dependencies.recordAuthorities ?? (() => Promise.resolve()),
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
  paymentProvider = refundCapability === "keyless" ? "sumup" : "stripe",
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
    readCharge: async (reference: string) => {
      reads.push(reference);
      const charge = await read(reference);
      return charge === null
        ? ({ reason: "network_error", status: "unavailable" } as const)
        : ({ resource: charge, status: "found" } as const);
    },
    reads,
    refundCharge: (request: AuthorizedRefundRequest) => {
      requireProviderRefundAuthorization(request, paymentProvider);
      return answerRefund(request);
    },
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
  paymentProvider: PaymentProviderType = "stripe",
): TaggedRefundPaymentReference =>
  taggedRefundReference(reference, paymentProvider, {
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
  paymentProvider: PaymentProviderType = "stripe",
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: [
    rowBackedReference(
      `pi-${sessionId}`,
      sessionId,
      "completed",
      paymentProvider,
    ),
  ],
});

export const pendingCandidate = (
  attendeeId: number,
  references: string[],
): RefundCandidate => ({
  attendee: { id: attendeeId } as RefundCandidate["attendee"],
  references: references.map((reference) =>
    taggedRefundReference(reference, "stripe", { sessionIds: [] }),
  ),
});

export const failingProvider = (
  refundCapability: RefundProviderCapability = "keyed",
): RecordingProvider =>
  provider({
    refund: () =>
      Promise.resolve({
        kind: "rejected",
        reason: "failed",
      }),
    refundCapability,
  });
