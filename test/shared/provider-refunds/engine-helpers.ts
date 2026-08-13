import { queryOne } from "#shared/db/client.ts";
import {
  loadRefundAuthorityByReference,
  type RefundAuthorityRow,
  transitionRefundAuthority,
} from "#shared/db/provider-refund-authority.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  armRefundSend,
  markRefundObservationDue,
} from "#shared/payment/refund-authority.ts";
import type { AuthorizedRefundRequest } from "#shared/payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import type {
  ProviderRefundDependencies,
  ProviderRefundTarget,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import {
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";

export const refundReference = (
  raw: string,
  provider: PaymentProviderType = "sumup",
): TaggedPaymentReference => ({ kind: "tagged", provider, reference: raw });

export const fakeRefundProvider = (
  provider: PaymentProviderType,
  read: () => ReturnType<RefundEngineProvider["readCharge"]>,
  send: (
    request: AuthorizedRefundRequest,
  ) => ReturnType<RefundEngineProvider["refundCharge"]>,
): RefundEngineProvider => ({
  readCharge: read,
  refundCapability: provider === "sumup" ? "keyless" : "keyed",
  refundCharge: send,
  type: provider,
});

export const completingRefundProvider = (
  provider: PaymentProviderType,
  observed: ChargeMoney = fullyRefundedMoney(),
): RefundEngineProvider =>
  fakeRefundProvider(
    provider,
    () => Promise.resolve(foundCharge(observed)),
    (request) => Promise.resolve(completedRefund(request.charge)),
  );

export const refundDependencies = (
  provider: RefundEngineProvider,
  now: () => number = () => 100,
): ProviderRefundDependencies => ({
  loadProvider: () => Promise.resolve(provider),
  now,
});

export const sendRefundTarget = (
  reference: TaggedPaymentReference,
  callbackSessionId?: string,
): ProviderRefundTarget =>
  callbackSessionId === undefined
    ? { evidence: { kind: "read_provider" }, mode: "send", reference }
    : {
        callbackSessionId,
        evidence: { kind: "read_provider" },
        mode: "send",
        reference,
      };

export const storedRefundAuthority = (index: string) =>
  queryOne<{
    callback_replay_index: string | null;
    captured_amount: number;
    provider_reference: string;
    refunded_amount: number;
    refund_local_state: string;
    refund_revision: number;
    refund_state_name: string;
  }>(
    `SELECT callback_replay_index, captured_amount, provider_reference,
            refunded_amount, refund_local_state, refund_revision,
            refund_state_name
       FROM payment_charges
      WHERE reference_index = ?`,
    [index],
  );

/** Move a newly-created keyed authority to one exact observation state. */
export const observingKeyedAuthority = async (
  index: string,
  observedAt: number,
  nextActionAt: number,
): Promise<RefundAuthorityRow> => {
  const row = await loadRefundAuthorityByReference(index);
  if (row === null || row.state.kind !== "ready") {
    throw new Error("Expected a ready authority to observe");
  }
  const changed = await transitionRefundAuthority(
    row,
    observedAt,
    row.refunded,
    (state) =>
      markRefundObservationDue(
        armRefundSend(state, observedAt, nextActionAt),
        observedAt,
        nextActionAt,
      ),
  );
  if (changed === null) throw new Error("Authority observation changed");
  return changed;
};
