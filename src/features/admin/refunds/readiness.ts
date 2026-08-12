import { requiredMapValue, unique, uniqueBy } from "#fp";
import {
  bindPaymentReferenceProviders,
  type PaymentReferenceProviderBinding,
  type PaymentReferenceProviderBindingResult,
} from "#shared/db/payment-reference-provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import {
  type PaymentReferenceEvidence,
  readPaymentReferenceEvidence,
} from "#shared/payment/provider-discovery.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { loadPaymentProvider, type PaymentProvider } from "#shared/payments.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import type { RefundCandidate } from "./candidates.ts";
import type { HeldRefundClaim } from "./claim.ts";
import { mapProviderRequests } from "./provider-requests.ts";

type TaggedRefundPaymentReference = Extract<
  RefundPaymentReference,
  { kind: "tagged" }
>;

/** The provider surface an already-read refund attempt still needs. */
export type ReadyRefundProvider = Pick<
  PaymentProvider,
  "refundCapability" | "refundCharge" | "type"
>;

type ReadyRefundReferenceBase = {
  provider: ReadyRefundProvider;
  reference: TaggedRefundPaymentReference;
};

/** One reference after every provider read and provider binding has finished. */
export type ReadyRefundReference =
  | (ReadyRefundReferenceBase & {
      charge: ChargeMoney;
      kind: "observed";
    })
  | (ReadyRefundReferenceBase & { kind: "already_returned" });

export type ReadyRefundCandidate = Omit<RefundCandidate, "references"> & {
  references: ReadyRefundReference[];
};

export type FailedPaymentReferenceEvidence = Exclude<
  PaymentReferenceEvidence,
  { status: "found" }
>;

export type RefundReadinessRead = {
  evidence: FailedPaymentReferenceEvidence;
  index: string;
};

/** A successful provider read that must survive a sibling readiness failure. */
export type RefundReadinessObservation = {
  readonly charge: ChargeMoney;
  readonly reference: RefundPaymentReference;
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
    }
  | {
      kind: "not_ready";
      observations: readonly RefundReadinessObservation[];
      reason: "claim_changed";
    }
  | {
      indexes: readonly string[];
      kind: "not_ready";
      observations: readonly RefundReadinessObservation[];
      reason: "historical_marker";
    };

export type RefundReadinessDependencies = {
  bindProviders: typeof bindPaymentReferenceProviders;
  loadProvider: (provider: PaymentProviderType) => Promise<ReadyRefundProvider>;
  readEvidence: typeof readPaymentReferenceEvidence;
};

const DEFAULT_DEPENDENCIES: RefundReadinessDependencies = {
  bindProviders: bindPaymentReferenceProviders,
  loadProvider: loadPaymentProvider,
  readEvidence: readPaymentReferenceEvidence,
};

const returned = (
  reference: RefundPaymentReference,
  alreadyReturned: ReadonlySet<string>,
): boolean =>
  reference.refundState === "completed" || alreadyReturned.has(reference.index);

const uniqueReferences = (
  candidates: readonly RefundCandidate[],
): RefundPaymentReference[] =>
  uniqueBy((reference: RefundPaymentReference) => reference.index)(
    candidates.flatMap(({ references }) => references),
  );

const providerIdentity = (
  reference: RefundPaymentReference,
  provider: PaymentProviderType,
): TaggedPaymentReference => ({
  kind: "tagged",
  provider,
  reference: reference.reference,
});

type PreparedReferenceBase = {
  identity: TaggedPaymentReference;
  original: RefundPaymentReference;
};

type PreparedReference =
  | (PreparedReferenceBase & { charge: ChargeMoney; kind: "observed" })
  | (PreparedReferenceBase & {
      kind: "already_returned";
      original: TaggedRefundPaymentReference;
    });

type PreparedEvidence =
  | { kind: "failed"; read: RefundReadinessRead }
  | { kind: "prepared"; reference: PreparedReference };

const readinessObservations = (
  prepared: readonly PreparedReference[],
): RefundReadinessObservation[] =>
  prepared.flatMap((entry) =>
    entry.kind === "observed"
      ? [{ charge: entry.charge, reference: entry.original }]
      : [],
  );

const evidenceFailed = (
  evidence: PreparedEvidence,
): evidence is Extract<PreparedEvidence, { kind: "failed" }> =>
  evidence.kind === "failed";

const prepareEvidence = (
  original: RefundPaymentReference,
  evidence: PaymentReferenceEvidence,
): PreparedEvidence =>
  evidence.status === "found"
    ? {
        kind: "prepared",
        reference: {
          charge: evidence.charge,
          identity: providerIdentity(original, evidence.provider),
          kind: "observed",
          original,
        },
      }
    : { kind: "failed", read: { evidence, index: original.index } };

const readReferences = (
  references: readonly RefundPaymentReference[],
  readEvidence: RefundReadinessDependencies["readEvidence"],
): Promise<PreparedEvidence[]> =>
  mapProviderRequests(references, async (reference) =>
    prepareEvidence(reference, await readEvidence(reference)),
  );

const alreadyReturnedReference = (
  reference: TaggedRefundPaymentReference,
): PreparedReference => ({
  identity: providerIdentity(reference, reference.provider),
  kind: "already_returned",
  original: reference,
});

const loadProviders = async (
  references: readonly PreparedReference[],
  loadProvider: RefundReadinessDependencies["loadProvider"],
): Promise<ReadonlyMap<PaymentProviderType, ReadyRefundProvider>> => {
  const types = unique(references.map(({ identity }) => identity.provider));
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

const taggedReference = (
  original: RefundPaymentReference,
  prepared: PreparedReference,
  index: string,
): TaggedRefundPaymentReference => ({
  ...original,
  ...prepared.identity,
  index,
});

const readyReference = (
  original: RefundPaymentReference,
  prepared: PreparedReference,
  provider: ReadyRefundProvider,
  index: string,
): ReadyRefundReference => {
  const reference = taggedReference(original, prepared, index);
  return prepared.kind === "already_returned"
    ? { kind: "already_returned", provider, reference }
    : {
        charge: prepared.charge,
        kind: "observed",
        provider,
        reference,
      };
};

const readyCandidates = (
  candidates: readonly RefundCandidate[],
  preparedByIndex: ReadonlyMap<string, PreparedReference>,
  providers: ReadonlyMap<PaymentProviderType, ReadyRefundProvider>,
  boundIndexes: ReadonlyMap<string, string>,
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
        reference,
        prepared,
        requiredMapValue(
          providers,
          prepared.identity.provider,
          `Refund readiness lost provider ${prepared.identity.provider}`,
        ),
        requiredMapValue(
          boundIndexes,
          reference.index,
          `Provider binding lost payment reference ${reference.index}`,
        ),
      );
    }),
  }));

const bindingResult = (
  result: PaymentReferenceProviderBindingResult,
  candidates: readonly RefundCandidate[],
  prepared: readonly PreparedReference[],
  providers: ReadonlyMap<PaymentProviderType, ReadyRefundProvider>,
): RefundReadinessResult => {
  const observations = readinessObservations(prepared);
  switch (result.kind) {
    case "claim_changed":
      return { kind: "not_ready", observations, reason: "claim_changed" };
    case "historical_marker":
      return {
        indexes: result.indexes,
        kind: "not_ready",
        observations,
        reason: "historical_marker",
      };
    case "bound":
      return {
        candidates: readyCandidates(
          candidates,
          new Map(prepared.map((entry) => [entry.original.index, entry])),
          providers,
          result.indexes,
        ),
        kind: "ready",
      };
  }
};

/** Resolve and bind every charge before a refund run may send any money. */
export const prepareRefundReadiness = async (
  candidates: readonly RefundCandidate[],
  claim: HeldRefundClaim,
  alreadyReturned: ReadonlySet<string>,
  dependencies: Partial<RefundReadinessDependencies> = {},
): Promise<RefundReadinessResult> => {
  const { bindProviders, loadProvider, readEvidence } = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  };
  const references = uniqueReferences(candidates);
  const historical = references.filter(
    (reference) =>
      reference.kind === "untagged" && returned(reference, alreadyReturned),
  );
  if (historical.length > 0) {
    return {
      indexes: historical.map(({ index }) => index),
      kind: "not_ready",
      observations: [],
      reason: "historical_marker",
    };
  }

  const marked = references.filter(
    (reference): reference is TaggedRefundPaymentReference =>
      reference.kind === "tagged" && returned(reference, alreadyReturned),
  );
  const readings = await readReferences(
    references.filter((reference) => !returned(reference, alreadyReturned)),
    readEvidence,
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
  const providers = await loadProviders(prepared, loadProvider);
  const result = await bindProviders({
    bindings: new Map(
      prepared.map(({ identity, original }) => [
        original.index,
        {
          capability: requiredMapValue(
            providers,
            identity.provider,
            `Refund readiness lost provider ${identity.provider}`,
          ).refundCapability,
          identity,
        } satisfies PaymentReferenceProviderBinding,
      ]),
    ),
    ...claim,
  });
  return bindingResult(result, candidates, prepared, providers);
};
