import { getDb, insert } from "#db/client.ts";
import { storePaymentReference } from "#db/payment-reference-store.ts";
import { armRefundSend } from "#payment/refund-authority.ts";
import { markRefundOwnerChoiceNeeded } from "#payment/refund-authority-choice.ts";
import {
  type RefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#payment/refund-authority-state.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";
import type { PaymentProviderType } from "#types";

export const readyRefundTestState = (identity: string): RefundAuthorityState =>
  readyRefundForTest("keyless", {
    evidenceRevision: 1,
    identityIndex: identity,
    nextActionAt: 20,
    now: 10,
  });

export const ownerRefundChoiceTestState = (
  identity: string,
): RefundAuthorityState =>
  markRefundOwnerChoiceNeeded(
    armRefundSend(readyRefundTestState(identity), 11, 20),
    12,
    "possibly_sent",
  );

/** Store one canonical authority row for owner-route and database tests. */
export const addProviderRefundTestCase = async (
  reference: string,
  state: RefundAuthorityState = ownerRefundChoiceTestState(
    `request-${reference}`,
  ),
  provider: PaymentProviderType = "sumup",
  refundedAmount = state.kind === "completed" ? 2_500 : 0,
): Promise<number> => {
  const paymentReference = { kind: "tagged", provider, reference } as const;
  const stored = await storePaymentReference(paymentReference);
  const stamp = 1_700_000_000_000;
  const result = await getDb().execute(
    insert("payment_charges", {
      callback_replay_index: null,
      capability: state.request.capability,
      captured_amount: 2_500,
      created_at: stamp,
      currency: "GBP",
      next_refund_action_at: refundNextActionAt(state),
      observed_at: stamp,
      provider,
      provider_reference: stored.encrypted,
      reference_index: stored.index,
      refund_local_state: refundLocalMirror(state),
      refund_revision: 1,
      refund_state: writeRefundAuthorityState(state),
      refund_state_name: refundStateMirror(state),
      refunded_amount: refundedAmount,
      updated_at: stamp,
    }),
  );
  return Number(result.lastInsertRowid);
};
