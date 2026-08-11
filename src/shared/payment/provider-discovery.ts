import {
  orderedCredentialedPaymentProviderTypes,
  paymentProviderHasCredentials,
} from "#shared/existing-payment-provider.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import {
  loadPaymentProvider,
  type PaymentProviderType,
} from "#shared/payments.ts";

export type ProviderReadAttempt = {
  provider: PaymentProviderType;
  result: ProviderRead<ChargeMoney>;
};

type PaymentReferenceEvidenceBase = {
  attempts: ProviderReadAttempt[];
  reference: string;
};

type FoundPaymentReferenceEvidence = PaymentReferenceEvidenceBase & {
  charge: ChargeMoney;
  provider: PaymentProviderType;
  source: "discovered" | "tagged";
  status: "found";
};

type TaggedPaymentReferenceFailure = PaymentReferenceEvidenceBase & {
  provider: PaymentProviderType;
  source: "tagged";
} & Exclude<ProviderRead<ChargeMoney>, { status: "found" }>;

type UnresolvedPaymentReferenceEvidence = PaymentReferenceEvidenceBase & {
  reason: "multiple_validating_providers" | "no_validating_provider";
  source: "untagged";
  status: "unresolved";
};

/** Provider identity plus the exact charge evidence that proved it. */
export type PaymentReferenceEvidence =
  | FoundPaymentReferenceEvidence
  | TaggedPaymentReferenceFailure
  | UnresolvedPaymentReferenceEvidence;

type FoundProviderReadAttempt = ProviderReadAttempt & {
  result: Extract<ProviderRead<ChargeMoney>, { status: "found" }>;
};

const foundAttempt = (
  attempt: ProviderReadAttempt,
): attempt is FoundProviderReadAttempt => attempt.result.status === "found";

const readAtProvider = async (
  provider: PaymentProviderType,
  reference: string,
): Promise<ProviderReadAttempt> => ({
  provider,
  result: await (await loadPaymentProvider(provider)).readCharge(reference),
});

const readInOrder = async (
  providers: PaymentProviderType[],
  reference: string,
): Promise<ProviderReadAttempt[]> => {
  const [provider, ...remaining] = providers;
  if (provider === undefined) return [];
  return [
    await readAtProvider(provider, reference),
    ...(await readInOrder(remaining, reference)),
  ];
};

const taggedEvidence = async (
  reference: Extract<PaymentReference, { kind: "tagged" }>,
): Promise<PaymentReferenceEvidence> => {
  const { provider } = reference;
  if (!paymentProviderHasCredentials(provider)) {
    return {
      attempts: [],
      provider,
      reason: "not_configured",
      reference: reference.reference,
      source: "tagged",
      status: "unavailable",
    };
  }

  const attempt = await readAtProvider(provider, reference.reference);
  return attempt.result.status === "found"
    ? {
        attempts: [attempt],
        charge: attempt.result.resource,
        provider,
        reference: reference.reference,
        source: "tagged",
        status: "found",
      }
    : {
        ...attempt.result,
        attempts: [attempt],
        provider,
        reference: reference.reference,
        source: "tagged",
      };
};

const discoveredEvidence = async (
  reference: Extract<PaymentReference, { kind: "untagged" }>,
): Promise<PaymentReferenceEvidence> => {
  const attempts = await readInOrder(
    orderedCredentialedPaymentProviderTypes(),
    reference.reference,
  );
  const [proof, ...otherProofs] = attempts.filter(foundAttempt);
  if (proof === undefined) {
    return {
      attempts,
      reason: "no_validating_provider",
      reference: reference.reference,
      source: "untagged",
      status: "unresolved",
    };
  }
  if (otherProofs.length > 0) {
    return {
      attempts,
      reason: "multiple_validating_providers",
      reference: reference.reference,
      source: "untagged",
      status: "unresolved",
    };
  }
  return {
    attempts,
    charge: proof.result.resource,
    provider: proof.provider,
    reference: reference.reference,
    source: "discovered",
    status: "found",
  };
};

/** Read a tagged reference only at its provider, or discover an old one. */
export const readPaymentReferenceEvidence = (
  reference: PaymentReference,
): Promise<PaymentReferenceEvidence> =>
  reference.kind === "tagged"
    ? taggedEvidence(reference)
    : discoveredEvidence(reference);
