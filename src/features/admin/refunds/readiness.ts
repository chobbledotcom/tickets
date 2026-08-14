import { requiredMapValue, unique, uniqueBy } from "#fp";
import type { TaggedRefundPaymentReference } from "#shared/db/payment-references.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { loadPaymentProvider, type PaymentProvider } from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import type { RefundCandidate } from "./candidates.ts";
import type { HeldRefundClaim } from "./claim.ts";
import { mapProviderRequests } from "./provider-requests.ts";

/** The provider surface an already-read refund attempt still needs. */
export type ReadyRefundProvider = Pick<
  PaymentProvider,
  "readCharge" | "refundCapability" | "refundCharge" | "type"
>;

type ReadyRefundReferenceBase = {
  provider: ReadyRefundProvider;
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
  loadProvider: (provider: PaymentProviderType) => Promise<ReadyRefundProvider>;
};

const DEFAULT_DEPENDENCIES: RefundReadinessDependencies = {
  loadProvider: loadPaymentProvider,
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
): TaggedPaymentReference => ({
  kind: "tagged",
  provider: reference.provider,
  reference: reference.reference,
});

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
  providers: ReadonlyMap<PaymentProviderType, ReadyRefundProvider>,
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
  providers: ReadonlyMap<PaymentProviderType, ReadyRefundProvider>,
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
): Promise<ReadonlyMap<PaymentProviderType, ReadyRefundProvider>> => {
  const types = unique(references.map(({ provider }) => provider));
  return new Map(
    await Promise.all(
      types.map(
        async (
          type,
        ): Promise<readonly [PaymentProviderType, ReadyRefundProvider]> => [
          type,
          await loadProvider(type),
        ],
      ),
    ),
  );
};

const readyReference = (
  prepared: PreparedReference,
  provider: ReadyRefundProvider,
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
  providers: ReadonlyMap<PaymentProviderType, ReadyRefundProvider>,
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
