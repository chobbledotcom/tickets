import { getDb } from "#db/client.ts";
import { storePaymentReference } from "#db/payment-reference-store.ts";
import { tables } from "#db/select/tables.ts";
import { insertInto } from "#db/write.ts";
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

/** Store one canonical authority row for the refund-route and database tests. */
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
    insertInto(tables.payment_charges, {
      callbackReplayIndex: null,
      capability: state.request.capability,
      capturedAmount: 2_500,
      createdAt: stamp,
      currency: "GBP",
      nextRefundActionAt: refundNextActionAt(state),
      observedAt: stamp,
      provider,
      providerReference: stored.encrypted,
      referenceIndex: stored.index,
      refundedAmount,
      refundLocalState: refundLocalMirror(state),
      refundRevision: 1,
      refundState: writeRefundAuthorityState(state),
      refundStateName: refundStateMirror(state),
      updatedAt: stamp,
    }),
  );
  return Number(result.lastInsertRowid);
};
