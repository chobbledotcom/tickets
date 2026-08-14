import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import { REFUND_OBSERVATION_DELAY_MS } from "#shared/provider-refunds/state.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  completedRefund,
  foundCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";
import {
  completingRefundProvider,
  fakeRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "./engine-helpers.ts";

describeWithEnv("provider refund state transitions", { db: true }, () => {
  test("already-returned evidence stores no DB-key-readable provider id", async () => {
    const payment = refundReference("txn-owner-only");

    expect(
      await requestProviderRefund(
        sendRefundTarget(payment),
        refundDependencies(completingRefundProvider("sumup")),
      ),
    ).toMatchObject({ kind: "returned", local: "due" });
    const stored = await storedRefundAuthority(
      await paymentReferenceIndex(payment),
    );
    expect(stored?.provider_reference.startsWith("hyb:1:")).toBe(true);
    expect(stored?.provider_reference).not.toContain(payment.reference);
  });

  for (const [reference, charge] of [
    ["txn-conflict", chargeMoney(1_000, 100)],
    ["txn-impossible-return", chargeMoney(1_000, 1_001)],
  ] as const) {
    test(`provider conflict becomes owner work for ${reference}`, async () => {
      const payment = refundReference(reference, "stripe");
      expect(
        await requestProviderRefund(
          sendRefundTarget(payment),
          refundDependencies(completingRefundProvider("stripe", charge)),
        ),
      ).toMatchObject({
        kind: "needs_owner_choice",
        reason: "provider_conflict",
      });
      expect(
        await storedRefundAuthority(await paymentReferenceIndex(payment)),
      ).toMatchObject({ refunded_amount: 0 });
    });
  }

  test("observation records fresh evidence without arming a send", async () => {
    const payment = refundReference("txn-observe-only");
    const pending = chargeMoneyWith({
      refunds: [refundObservation({ status: "pending" })],
    });
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const answer = await requestProviderRefund(
      {
        evidence: { charge: pending, kind: "observed" },
        mode: "observe_only",
        reference: payment,
      },
      refundDependencies(provider),
    );

    expect(answer).toMatchObject({ kind: "pending", state: "observing" });
    expect(sends).toBe(0);
    expect(
      (
        await loadRefundAuthorityByReference(
          await paymentReferenceIndex(payment),
        )
      )?.state,
    ).toMatchObject({
      kind: "observing",
      nextActionAt: 100 + REFUND_OBSERVATION_DELAY_MS,
    });
  });
});
