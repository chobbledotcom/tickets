import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, foundCharge } from "#test-utils/payment-state.ts";
import {
  fakeRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "../engine-helpers.ts";

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
});
