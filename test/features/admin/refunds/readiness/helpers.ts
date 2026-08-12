import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { HeldRefundClaim } from "#routes/admin/refunds/claim.ts";
import type {
  ReadyRefundProvider,
  RefundReadinessDependencies,
} from "#routes/admin/refunds/readiness.ts";
import type { PaymentReferenceProviderBindingRequest } from "#shared/db/payment-reference-provider.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { PaymentReferenceEvidence } from "#shared/payment/provider-discovery.ts";
import type { PaymentReference } from "#shared/payment/provider-reference.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { provider as recordingProvider } from "#test/features/admin/refunds/provider/helpers.ts";

export const charge = (): ChargeMoney => ({
  captured: { amount: 1000, currency: "GBP" },
  confirmedRefunded: { amount: 0, currency: "GBP" },
  refunds: [],
});

const referenceFacts = (
  index: string,
  refundState: RefundPaymentReference["refundState"] = "none",
) => ({
  heldRowSessionIds: [`session_${index}`],
  index,
  matchingIndexes: [index],
  refundState,
  rowSessionIds: [`session_${index}`],
  sessionIds: [`session_${index}`],
});

export const untagged = (
  reference: string,
  index = `old_${reference}`,
  refundState: RefundPaymentReference["refundState"] = "none",
): Extract<RefundPaymentReference, { kind: "untagged" }> => ({
  ...referenceFacts(index, refundState),
  kind: "untagged",
  reference,
});

export const tagged = (
  reference: string,
  provider: PaymentProviderType,
  index = `tagged_${reference}`,
  refundState: RefundPaymentReference["refundState"] = "none",
): Extract<RefundPaymentReference, { kind: "tagged" }> => ({
  ...referenceFacts(index, refundState),
  kind: "tagged",
  provider,
  reference,
});

export const candidate = (
  id: number,
  references: RefundPaymentReference[],
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references,
});

export const heldClaim: HeldRefundClaim = {
  held: new Map([
    [1, ["session_old_shared", "session_tagged_returned"]],
    [2, ["session_old_shared"]],
  ]),
  heldSince: "2026-08-11T12:00:00.000Z",
};

export const provider = (
  type: PaymentProviderType,
  refundCapability: ReadyRefundProvider["refundCapability"] = "keyed",
): ReadyRefundProvider =>
  recordingProvider({ paymentProvider: type, refundCapability });

export const found = (
  reference: PaymentReference,
  provider: PaymentProviderType,
  observed: ChargeMoney,
): PaymentReferenceEvidence => ({
  attempts: [
    {
      provider,
      result: { resource: observed, status: "found" },
    },
  ],
  charge: observed,
  provider,
  reference: reference.reference,
  source: reference.kind === "tagged" ? "tagged" : "discovered",
  status: "found",
});

export const boundIndexes = (
  bindings: PaymentReferenceProviderBindingRequest["bindings"],
): ReadonlyMap<string, string> =>
  new Map([...bindings.keys()].map((index) => [index, `bound_${index}`]));

export const stripeReadiness = (
  readEvidence: RefundReadinessDependencies["readEvidence"],
): Partial<RefundReadinessDependencies> => ({
  bindProviders: (request) =>
    Promise.resolve({
      indexes: boundIndexes(request.bindings),
      kind: "bound",
    }),
  loadProvider: () => Promise.resolve(provider("stripe")),
  readEvidence,
});
