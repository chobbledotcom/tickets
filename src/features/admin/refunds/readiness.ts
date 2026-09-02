import type { TaggedRefundPaymentReference } from "#db/payment-references.ts";
import { requiredMapValue, uniqueBy } from "#fp";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  type TaggedPaymentReference,
  taggedPaymentReference,
} from "#payment/provider-reference.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import {
  loadRefundProvider,
  type RefundEngineProvider,
} from "#shared/provider-refunds.ts";
import type { PaymentProviderType } from "#types";
import type { RefundCandidate } from "./candidates.ts";
import type { HeldRefundClaim } from "./claim.ts";
import { mapProviderRequests } from "./provider-requests.ts";

type ReadyRefundReferenceBase = {
  provider: RefundEngineProvider;
  reference: TaggedRefundPaymentReference;
};

/** One provider-tagged reference after its exact provider read has finished. */
export type ReadyRefundReference =
  | (ReadyRefundReferenceBase & {
      charge: ChargeMoney;
      kind: "observed";
    })
  | (ReadyRefundReferenceBase & { kind: "already_returned" });

export type ReadyRefundCandidate = Omit<RefundCandidate, "references"> & {
  references: ReadyRefundReference[];
};

export type FailedPaymentReferenceEvidence = {
  provider: PaymentProviderType;
  reference: string;
} & Exclude<ProviderRead<ChargeMoney>, { status: "found" }>;

export type RefundReadinessRead = {
  evidence: FailedPaymentReferenceEvidence;
  index: string;
};

/** A successful provider read that must survive a sibling readiness failure. */
export type RefundReadinessObservation = {
  readonly charge: ChargeMoney;
  readonly identity: TaggedPaymentReference;
  readonly reference: TaggedRefundPaymentReference;
};

export type RefundReadinessResult =
  | {
      candidates: ReadyRefundCandidate[];
      kind: "ready";
    }
  | {
      kind: "not_ready";
      observations: readonly RefundReadinessObservation[];
      reads: RefundReadinessRead[];
      reason: "provider_evidence";
    };

export type RefundReadinessDependencies = {
  loadProvider: (
    reference: TaggedPaymentReference,
  ) => Promise<RefundEngineProvider>;
};

const DEFAULT_DEPENDENCIES: RefundReadinessDependencies = {
  loadProvider: loadRefundProvider,
};

const returned = (
  reference: TaggedRefundPaymentReference,
  alreadyReturned: ReadonlySet<string>,
): boolean =>
  reference.refundState === "completed" || alreadyReturned.has(reference.index);

const uniqueReferences = (
  candidates: readonly RefundCandidate[],
): TaggedRefundPaymentReference[] =>
  uniqueBy((reference: TaggedRefundPaymentReference) => reference.index)(
    candidates.flatMap(({ references }) => references),
  );

const providerIdentity = (
  reference: TaggedRefundPaymentReference,
): TaggedPaymentReference =>
  taggedPaymentReference(reference.provider, reference.reference);

type PreparedReference =
  | {
      charge: ChargeMoney;
      kind: "observed";
      original: TaggedRefundPaymentReference;
    }
  | {
      kind: "already_returned";
      original: TaggedRefundPaymentReference;
    };

type ObservedPreparedReference = Extract<
  PreparedReference,
  { kind: "observed" }
>;

type PreparedEvidence =
  | { kind: "failed"; read: RefundReadinessRead }
  | { kind: "prepared"; reference: ObservedPreparedReference };

const readinessObservations = (
  prepared: readonly ObservedPreparedReference[],
): RefundReadinessObservation[] =>
  prepared.map((entry) => ({
    charge: entry.charge,
    identity: providerIdentity(entry.original),
    reference: entry.original,
  }));

const evidenceFailed = (
  evidence: PreparedEvidence,
): evidence is Extract<PreparedEvidence, { kind: "failed" }> =>
  evidence.kind === "failed";

const readReference = async (
  reference: TaggedRefundPaymentReference,
  providers: ReadonlyMap<PaymentProviderType, RefundEngineProvider>,
): Promise<PreparedEvidence> => {
  const read = await requiredMapValue(
    providers,
    reference.provider,
    `Refund readiness lost provider ${reference.provider}`,
  ).readCharge(reference.reference);
  return read.status === "found"
    ? {
        kind: "prepared",
        reference: {
          charge: read.resource,
          kind: "observed",
          original: reference,
        },
      }
    : {
        kind: "failed",
        read: {
          evidence: {
            ...read,
            provider: reference.provider,
            reference: reference.reference,
          },
          index: reference.index,
        },
      };
};

const readReferences = (
  references: readonly TaggedRefundPaymentReference[],
  providers: ReadonlyMap<PaymentProviderType, RefundEngineProvider>,
): Promise<PreparedEvidence[]> =>
  mapProviderRequests(references, (reference) =>
    readReference(reference, providers),
  );

const alreadyReturnedReference = (
  reference: TaggedRefundPaymentReference,
): PreparedReference => ({ kind: "already_returned", original: reference });

const loadProviders = async (
  references: readonly TaggedRefundPaymentReference[],
  loadProvider: RefundReadinessDependencies["loadProvider"],
): Promise<ReadonlyMap<PaymentProviderType, RefundEngineProvider>> => {
  const providerReferences = uniqueBy(
    ({ provider }: TaggedRefundPaymentReference) => provider,
  )([...references]);
  return new Map(
    await Promise.all(
      providerReferences.map(
        async (
          reference,
        ): Promise<readonly [PaymentProviderType, RefundEngineProvider]> => [
          reference.provider,
          await loadProvider(reference),
        ],
      ),
    ),
  );
};

const readyReference = (
  prepared: PreparedReference,
  provider: RefundEngineProvider,
  reference: TaggedRefundPaymentReference,
): ReadyRefundReference =>
  prepared.kind === "already_returned"
    ? { kind: "already_returned", provider, reference }
    : {
        charge: prepared.charge,
        kind: "observed",
        provider,
        reference,
      };

const readyCandidates = (
  candidates: readonly RefundCandidate[],
  preparedByIndex: ReadonlyMap<string, PreparedReference>,
  providers: ReadonlyMap<PaymentProviderType, RefundEngineProvider>,
): ReadyRefundCandidate[] =>
  candidates.map((candidate) => ({
    attendee: candidate.attendee,
    references: candidate.references.map((reference) => {
      const prepared = requiredMapValue(
        preparedByIndex,
        reference.index,
        `Refund readiness lost payment reference ${reference.index}`,
      );
      return readyReference(
        prepared,
        requiredMapValue(
          providers,
          reference.provider,
          `Refund readiness lost provider ${reference.provider}`,
        ),
        reference,
      );
    }),
  }));

/** Read every current charge at its stored provider before any refund may send. */
export const prepareRefundReadiness = async (
  candidates: readonly RefundCandidate[],
  _claim: HeldRefundClaim,
  alreadyReturned: ReadonlySet<string>,
  dependencies: Partial<RefundReadinessDependencies> = {},
): Promise<RefundReadinessResult> => {
  const { loadProvider } = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const references = uniqueReferences(candidates);
  const providers = await loadProviders(references, loadProvider);
  const marked = references.filter((reference) =>
    returned(reference, alreadyReturned),
  );
  const readings = await readReferences(
    references.filter((reference) => !returned(reference, alreadyReturned)),
    providers,
  );
  const preparedReadings = readings.filter(
    (reading): reading is Extract<PreparedEvidence, { kind: "prepared" }> =>
      reading.kind === "prepared",
  );
  const failures = readings.filter(evidenceFailed);
  if (failures.length > 0) {
    return {
      kind: "not_ready",
      observations: readinessObservations(
        preparedReadings.map(({ reference }) => reference),
      ),
      reads: failures.map(({ read }) => read),
      reason: "provider_evidence",
    };
  }
  const prepared = [
    ...preparedReadings.map(({ reference }) => reference),
    ...marked.map(alreadyReturnedReference),
  ];
  return {
    candidates: readyCandidates(
      candidates,
      new Map(prepared.map((entry) => [entry.original.index, entry])),
      providers,
    ),
    kind: "ready",
  };
};
