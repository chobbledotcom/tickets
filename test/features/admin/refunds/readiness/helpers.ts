import type { RefundCandidate } from "#routes/admin/refunds/candidates.ts";
import type { HeldRefundClaim } from "#routes/admin/refunds/claim.ts";
import type {
  ReadyRefundProvider,
  RefundReadinessDependencies,
} from "#routes/admin/refunds/readiness.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import type {
  RefundPaymentReference,
  TaggedRefundPaymentReference,
} from "#shared/db/payment-references.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
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
): Pick<
  RefundPaymentReference,
  | "heldRowSessionIds"
  | "index"
  | "matchingIndexes"
  | "refundState"
  | "rowSessionIds"
  | "sessionIds"
> => ({
  heldRowSessionIds: [`session_${index}`],
  index,
  matchingIndexes: [index],
  refundState,
  rowSessionIds: [`session_${index}`],
  sessionIds: [`session_${index}`],
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

export const canonicalTagged = async (
  ...input: Parameters<typeof tagged>
): Promise<ReturnType<typeof tagged>> => {
  const reference = tagged(...input);
  const index = await paymentReferenceIndex(reference);
  return { ...reference, index, matchingIndexes: [index] };
};

export const candidate = (
  id: number,
  references: TaggedRefundPaymentReference[],
): RefundCandidate => ({
  attendee: { id } as RefundCandidate["attendee"],
  references,
});

export const heldClaim: HeldRefundClaim = {
  commandId: "test-command",
  held: new Map([
    [1, ["session_old_shared", "session_tagged_returned"]],
    [2, ["session_old_shared"]],
  ]),
  heldSince: "2026-08-11T12:00:00.000Z",
  phases: new Map([
    ["session_old_shared", "checking"],
    ["session_tagged_returned", "checking"],
  ]),
};

export const provider = (
  type: PaymentProviderType,
  refundCapability: ReadyRefundProvider["refundCapability"] = "keyed",
): ReadyRefundProvider =>
  recordingProvider({ paymentProvider: type, refundCapability });

export const stripeReadiness = (
  readCharge: (reference: string) => Promise<ProviderRead<ChargeMoney>>,
): Partial<RefundReadinessDependencies> => ({
  loadProvider: () => Promise.resolve({ ...provider("stripe"), readCharge }),
});
