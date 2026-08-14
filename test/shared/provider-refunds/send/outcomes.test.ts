import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import {
  type RefundRequestGeneration,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import {
  fakeRefundProvider,
  notSentRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "#test/shared/provider-refunds/engine-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, foundCharge } from "#test-utils/payment-state.ts";

const replaceStoredRequest = async (
  payment: ReturnType<typeof refundReference>,
  change: (request: RefundRequestGeneration) => RefundRequestGeneration,
): Promise<void> => {
  const row = await loadRefundAuthorityByReference(
    await paymentReferenceIndex(payment),
  );
  if (row === null) throw new Error("Expected a stored refund authority");
  const state = { ...row.state, request: change(row.state.request) };
  await execute(
    `UPDATE payment_charges
        SET capability = ?, refund_state = ?
      WHERE id = ?`,
    [state.request.capability, writeRefundAuthorityState(state), row.id],
  );
};

describeWithEnv("provider refund engine outcomes", { db: true }, () => {
  test("refuses a completed provider answer for different money", async () => {
    const payment = refundReference("txn-wrong-completion", "stripe");
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      () =>
        Promise.resolve({
          amount: { amount: 999, currency: "GBP" },
          kind: "completed",
          proof: { charge: chargeMoney(), kind: "charge_observation" },
        }),
    );

    await expect(
      requestProviderRefund(
        sendRefundTarget(payment),
        refundDependencies(provider),
      ),
    ).rejects.toThrow("Provider completed a refund for different money");
    expect(
      await storedRefundAuthority(await paymentReferenceIndex(payment)),
    ).toMatchObject({
      refund_state_name: "send_armed",
      refunded_amount: 0,
    });
  });

  for (const { change, error, payment } of [
    {
      change: (request: RefundRequestGeneration) => ({
        ...request,
        identityIndex: "another-generation",
      }),
      error: "generation identity does not match its charge",
      payment: refundReference("txn-wrong-generation", "stripe"),
    },
    {
      change: (request: RefundRequestGeneration) => ({
        capability: "keyless" as const,
        generation: request.generation,
        identityIndex: request.identityIndex,
      }),
      error: "Keyless refund generation does not belong to SumUp",
      payment: refundReference("txn-keyless-stripe", "stripe"),
    },
    {
      change: (request: RefundRequestGeneration) => ({
        capability: "keyed" as const,
        generation: request.generation,
        identityIndex: request.identityIndex,
        replayUntil: 500,
      }),
      error: "Keyed refund generation cannot belong to SumUp",
      payment: refundReference("txn-keyed-sumup"),
    },
  ] as const) {
    test(`refuses inconsistent durable state: ${error}`, async () => {
      const refunding = notSentRefundProvider(payment.provider);
      const dependencies = refundDependencies(refunding.provider);
      const target = sendRefundTarget(payment);

      expect(await requestProviderRefund(target, dependencies)).toMatchObject({
        kind: "ready",
      });
      await replaceStoredRequest(payment, change);
      expect(refunding.sendCount()).toBe(1);

      await expect(requestProviderRefund(target, dependencies)).rejects.toThrow(
        error,
      );
      expect(refunding.sendCount()).toBe(1);
    });
  }
});
