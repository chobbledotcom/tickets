import { queryOne } from "#db/client.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type {
  ProviderRefundDependencies,
  ProviderRefundTarget,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import type { PaymentProviderType } from "#types";

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
  refundCharge: send,
  type: provider,
});

export const validatedRefundTarget = (
  raw: string,
  callbackSessionId: string,
  captured = chargeMoney().captured,
): Extract<ProviderRefundTarget, { readonly callbackSessionId: string }> => ({
  callbackSessionId,
  evidence: { captured, kind: "validated_callback" },
  mode: "send",
  reference: refundReference(raw, "stripe"),
});

export const completingProviderThatReads = (
  readCharge: Parameters<typeof fakeRefundProvider>[1],
) => {
  let sendCount = 0;
  return {
    provider: fakeRefundProvider("stripe", readCharge, (request) => {
      sendCount++;
      return Promise.resolve(completedRefund(request.charge));
    }),
    sendCount: () => sendCount,
  };
};

export const completingRefundProvider = (
  provider: PaymentProviderType,
  observed: ChargeMoney = fullyRefundedMoney(),
): RefundEngineProvider => {
  const completedRead = foundCharge(observed);
  return fakeRefundProvider(
    provider,
    () => Promise.resolve(completedRead),
    (request) => Promise.resolve(completedRefund(request.charge)),
  );
};

export const notSentRefundProvider = (
  provider: PaymentProviderType,
  read: Parameters<typeof fakeRefundProvider>[1] = () =>
    Promise.resolve(foundCharge()),
) => {
  let sendCount = 0;
  return {
    provider: fakeRefundProvider(provider, read, () => {
      sendCount++;
      return Promise.resolve({ kind: "not_sent", reason: "not_configured" });
    }),
    sendCount: () => sendCount,
  };
};

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
