import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import {
  answerProviderConflict,
  completeRefundFromEvidence,
  observePendingRefund,
  REFUND_OBSERVATION_DELAY_MS,
  requireCurrentRefund,
} from "#shared/provider-refunds/state.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
  refundObservation,
} from "#test-utils/payment-state.ts";
import {
  completingRefundProvider,
  fakeRefundProvider,
  notSentRefundProvider,
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
    expect(
      await requestProviderRefund(
        {
          evidence: { charge: pending, kind: "observed" },
          mode: "observe_only",
          reference: payment,
        },
        refundDependencies(provider),
      ),
    ).toMatchObject({ kind: "pending", state: "observing" });
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

  test("two workers observing returned money converge on one completion", async () => {
    const payment = refundReference("txn-concurrent-completion");
    const provider = notSentRefundProvider("sumup").provider;
    expect(
      await requestProviderRefund(
        sendRefundTarget(payment),
        refundDependencies(provider),
      ),
    ).toMatchObject({ kind: "ready" });
    const row = await loadRefundAuthorityByReference(
      await paymentReferenceIndex(payment),
    );
    if (row === null) throw new Error("Expected a ready refund authority");

    const answers = await Promise.all([
      completeRefundFromEvidence(row, 200, payment),
      completeRefundFromEvidence(row, 200, payment),
    ]);
    expect(answers).toEqual([
      expect.objectContaining({ kind: "returned", local: "due" }),
      expect.objectContaining({ kind: "returned", local: "due" }),
    ]);
    const completed = await loadRefundAuthorityByReference(row.referenceIndex);
    if (completed === null) {
      throw new Error("Expected the completed refund authority");
    }
    expect(
      await completeRefundFromEvidence(completed, 201, payment),
    ).toMatchObject({ kind: "returned", local: "due" });
    expect(await answerProviderConflict(completed, 201, payment)).toMatchObject(
      { kind: "returned", local: "due" },
    );
    expect(
      await observePendingRefund(completed, fullyRefundedMoney(), 201, payment),
    ).toMatchObject({ kind: "returned", local: "due" });
    await expect(
      requireCurrentRefund({ id: completed.id + 1_000 }),
    ).rejects.toThrow("Refund authority disappeared");
  });

  test("stale provider disagreement cannot replace an owner choice", async () => {
    const payment = refundReference("txn-owner-conflict");
    let now = 100;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => Promise.resolve({ kind: "uncertain", reason: "network_error" }),
    );
    const dependencies = refundDependencies(provider, () => now);
    await requestProviderRefund(sendRefundTarget(payment), dependencies);
    now += REFUND_OBSERVATION_DELAY_MS;
    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
    const ownerChoice = await loadRefundAuthorityByReference(
      await paymentReferenceIndex(payment),
    );
    if (ownerChoice === null) {
      throw new Error("Expected an owner-choice refund authority");
    }

    expect(
      await answerProviderConflict(ownerChoice, now, payment),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
    expect(
      await observePendingRefund(ownerChoice, chargeMoney(), now, payment),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
  });
});
