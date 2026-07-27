import * as v from "valibot";
import type {
  PaymentSession,
  PaymentSessionCreate,
} from "#shared/db/payments/types.ts";
import { recoverError } from "#shared/error-recovery.ts";
import type { ProviderMetadata } from "#shared/payment-helpers.ts";
import {
  type PaymentAccount,
  resolvePaymentAccount,
} from "#shared/payment-runtime/account.ts";
import {
  type SignedBookingIntent,
  signedBookingIntentFromMetadata,
} from "#shared/payment-runtime/metadata.ts";
import { storedPaymentFacts } from "#shared/payment-state/facts.ts";
import {
  type ObservedPaymentStatus,
  PaymentInstantSchema,
  type PaymentObservation,
  type ProviderInvalidReason,
  type ProviderMissingReason,
  type ProviderRead,
  ProviderReadSchema,
  type ProviderUnavailableReason,
  signedPaymentOwnership,
  stagedPaymentOwnership,
} from "#shared/payment-state/observation.ts";
import type {
  ChargeLeg,
  Money,
  ProviderResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";

export type ProviderPaymentFacts = {
  charges?: ChargeLeg[] | undefined;
  createdAt: string;
  metadata?: ProviderMetadata | undefined;
  providerTotal: Money;
  session: ProviderSessionResource;
  status: ObservedPaymentStatus;
};

type ProviderPaymentFactsInput = readonly [
  session: ProviderSessionResource,
  providerTotal: Money,
  status: ObservedPaymentStatus,
  details: Pick<ProviderPaymentFacts, "charges" | "createdAt" | "metadata">,
];

export const providerPaymentFacts = (
  ...[session, providerTotal, status, details]: ProviderPaymentFactsInput
): ProviderPaymentFacts => ({ providerTotal, session, status, ...details });

export const providerFactDetails = (
  charges: ChargeLeg[] | undefined,
  createdAt: string | undefined,
  metadata?: ProviderMetadata,
): Pick<ProviderPaymentFacts, "charges" | "createdAt" | "metadata"> => ({
  ...(charges === undefined || charges.length === 0 ? {} : { charges }),
  createdAt: v.parse(PaymentInstantSchema, createdAt),
  ...(metadata === undefined ? {} : { metadata }),
});

export const providerCharge = (
  captured: Money,
  confirmedRefunded: Money,
  resource: ChargeLeg["resource"],
): ChargeLeg => ({ captured, confirmedRefunded, refunds: [], resource });

export const checkProviderValue = <Value>(
  value: Value | null,
  expectedId: string,
  idOf: (value: Value) => string | undefined,
  payment: PaymentSession | null,
  requested: ProviderResource,
): { read: ProviderRead } | { value: Value } => {
  if (value === null) {
    return { read: unavailableProviderRead(payment, requested) };
  }
  return idOf(value) === expectedId
    ? { value }
    : { read: invalidProviderRead(requested, payment, "mismatched_id") };
};

export const makeProviderValueReader =
  <Value>(
    load: (id: string) => Promise<Value | null>,
    idOf: (value: Value, expectedId: string) => string | undefined,
  ) =>
  async (
    expectedId: string,
    payment: PaymentSession | null,
    requested: ProviderResource,
  ): Promise<{ read: ProviderRead } | { value: Value }> =>
    checkProviderValue(
      await load(expectedId),
      expectedId,
      (value) => idOf(value, expectedId),
      payment,
      requested,
    );

export const foundProviderPayment = (
  payment: PaymentSession | null,
  requested: ProviderResource,
  ...facts: ProviderPaymentFactsInput
): Promise<ProviderRead> =>
  foundProviderRead(payment, requested, providerPaymentFacts(...facts));

export const adoptedPaymentId = (session: ProviderSessionResource): string =>
  `adopted:${session.provider}:${session.id}`;

export const signedPaymentFacts = (
  account: PaymentAccount,
  signed: SignedBookingIntent,
  currency: string,
): Pick<
  PaymentSessionCreate,
  "accountId" | "bookingIntent" | "expected" | "mode"
> => ({
  accountId: account.accountId,
  bookingIntent: signed.intent,
  expected: { amount: signed.total, currency },
  mode: account.mode,
});

type StoredObservationFacts = Pick<
  PaymentObservation,
  "accountId" | "bookingIntent" | "expected" | "mode" | "ownership"
>;

const storedObservationFacts = async (
  payment: PaymentSession | null,
  facts: ProviderPaymentFacts,
): Promise<StoredObservationFacts | null> => {
  if (payment !== null) {
    return {
      ...storedPaymentFacts(payment),
      ownership: stagedPaymentOwnership(payment.id, facts.session.id),
    };
  }
  if (facts.metadata === undefined) return null;
  const signed = await signedBookingIntentFromMetadata(facts.metadata);
  if (signed === null) return null;
  const account = await resolvePaymentAccount(facts.session.provider);
  return {
    ...signedPaymentFacts(account, signed, facts.providerTotal.currency),
    ownership: signedPaymentOwnership(
      signed.localPaymentId ?? adoptedPaymentId(facts.session),
      signed.signature,
    ),
  };
};

export const invalidProviderRead = (
  requested: ProviderResource,
  payment: PaymentSession | null,
  reason: ProviderInvalidReason,
): ProviderRead => providerReadIssue("invalid", reason, payment, requested);

export const invalidProviderReadFor = (
  context: { payment: PaymentSession | null; requested: ProviderResource },
  reason: Parameters<typeof invalidProviderRead>[2],
): ProviderRead =>
  invalidProviderRead(context.requested, context.payment, reason);

const providerReadIssue = (
  status: "invalid" | "missing" | "unavailable",
  reason:
    | ProviderInvalidReason
    | ProviderMissingReason
    | ProviderUnavailableReason,
  payment: PaymentSession | null,
  requested: ProviderResource,
): ProviderRead => {
  const ownership = paymentOwnership(payment);
  return v.parse(ProviderReadSchema, {
    ...(ownership === undefined ? {} : { ownership }),
    reason,
    requested,
    status,
  });
};

const paymentOwnership = (payment: PaymentSession | null) =>
  payment === null || payment.session === null
    ? undefined
    : stagedPaymentOwnership(payment.id, payment.session.id);

export const readProviderOrInvalid = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  read: () => Promise<ProviderRead>,
): Promise<ProviderRead> =>
  recoverError(read, (error) => {
    if (!(error instanceof v.ValiError)) throw error;
    return invalidProviderRead(requested, payment, "malformed_response");
  });

/** Turn one provider's parsed facts into the common read contract. */
export const foundProviderRead = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  facts: ProviderPaymentFacts,
): Promise<ProviderRead> => {
  if (
    requested.provider !== facts.session.provider ||
    ("parentId" in requested ? requested.parentId : requested.id) !==
      facts.session.id
  ) {
    return invalidProviderRead(requested, payment, "mismatched_parent");
  }

  const stored = await storedObservationFacts(payment, facts);
  if (stored === null) {
    return invalidProviderRead(requested, null, "malformed_response");
  }
  return v.parse(ProviderReadSchema, {
    observation: {
      ...stored,
      ...(facts.charges === undefined ? {} : { charges: facts.charges }),
      createdAt: facts.createdAt,
      providerTotal: facts.providerTotal,
      session: facts.session,
      status: facts.status,
    },
    requested,
    returned: requested,
    status: "found",
  });
};

const unresolvedProviderRead =
  (
    status: "missing" | "unavailable",
    reason: "not_found" | "provider_unavailable",
  ) =>
  (payment: PaymentSession | null, requested: ProviderResource): ProviderRead =>
    providerReadIssue(status, reason, payment, requested);

type UnresolvedProviderRead = (
  payment: PaymentSession | null,
  requested: ProviderResource,
) => ProviderRead;

export const unavailableProviderRead: UnresolvedProviderRead =
  unresolvedProviderRead("unavailable", "provider_unavailable");

export const missingProviderRead: UnresolvedProviderRead =
  unresolvedProviderRead("missing", "not_found");
