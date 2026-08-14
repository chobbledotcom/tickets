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
  gbp,
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

  for (
    const [reference, charge, refundedAmount] of [
      ["txn-conflict", chargeMoney(1_000, 100), 100],
      ["txn-impossible-return", chargeMoney(1_000, 1_001), 0],
    ] as const
  ) {
    test(`provider conflict becomes provider-check work for ${reference}`, async () => {
      const payment = refundReference(reference, "stripe");
      expect(
        await requestProviderRefund(
          sendRefundTarget(payment),
          refundDependencies(completingRefundProvider("stripe", charge)),
        ),
      ).toMatchObject({
        kind: "needs_provider_check",
        reason: "provider_conflict",
      });
      expect(
        await storedRefundAuthority(await paymentReferenceIndex(payment)),
      ).toMatchObject({ refunded_amount: refundedAmount });
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
    expect(
      await answerProviderConflict(fullyRefundedMoney())(
        completed,
        201,
        payment,
      ),
    ).toMatchObject({ kind: "returned", local: "due" });
    expect(
      await observePendingRefund(fullyRefundedMoney())(completed, 201, payment),
    ).toMatchObject({ kind: "returned", local: "due" });
    await expect(
      requireCurrentRefund({ id: completed.id + 1_000 }),
    ).rejects.toThrow("Refund authority disappeared");
  });

  test("fresh partial evidence replaces an ordinary owner choice", async () => {
    const payment = refundReference("txn-owner-conflict");
    let now = 100;
    let observed = chargeMoney();
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge(observed)),
      () => {
        sends++;
        return Promise.resolve({ kind: "uncertain", reason: "network_error" });
      },
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
      await observePendingRefund(chargeMoney())(ownerChoice, now, payment),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });

    observed = chargeMoney(1_000, 100);
    expect(
      await requestProviderRefund(
        {
          evidence: { kind: "read_provider" },
          mode: "observe_only",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });
    const providerCheck = await loadRefundAuthorityByReference(
      await paymentReferenceIndex(payment),
    );
    expect(providerCheck).toMatchObject({
      refunded: { amount: 100, currency: "GBP" },
      revision: ownerChoice.revision + 1,
      state: {
        decision: { kind: "returned" },
        kind: "needs_provider_check",
      },
    });
    expect(sends).toBe(1);
  });

  test("only identical provider-check evidence leaves its case unchanged", async () => {
    const payment = refundReference("txn-exact-owner-conflict", "stripe");
    const returnedMoney = (amount: number) =>
      chargeMoneyWith({
        captured: gbp(100),
        confirmedRefunded: gbp(amount),
        refunds: [refundObservation({ amount: gbp(amount) })],
      });
    const index = await paymentReferenceIndex(payment);
    const current = async () => {
      const row = await loadRefundAuthorityByReference(index);
      if (row === null) throw new Error("Expected a refund authority");
      return row;
    };
    const recheck = async (
      charge: ReturnType<typeof chargeMoney>,
      now: number,
    ) => {
      const before = await current();
      const answer = await answerProviderConflict(charge)(before, now, payment);
      return { after: await current(), answer, before };
    };

    expect(
      await requestProviderRefund(
        sendRefundTarget(payment),
        refundDependencies(
          completingRefundProvider("stripe", returnedMoney(10)),
        ),
      ),
    ).toMatchObject({
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });

    const identical = await recheck(returnedMoney(10), 101);
    expect(identical.answer).toMatchObject({
      authority: { revision: identical.before.revision },
      kind: "needs_provider_check",
    });
    expect(identical.after.revision).toBe(identical.before.revision);

    const changedReturn = await recheck(returnedMoney(20), 102);
    expect(changedReturn.after.revision).toBe(
      changedReturn.before.revision + 1,
    );
    expect(changedReturn.after.state).toMatchObject({
      decision: { kind: "returned", refunded: gbp(20) },
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });

    const backwardsReturn = await recheck(chargeMoney(100), 103);
    expect(backwardsReturn.after.revision).toBe(
      backwardsReturn.before.revision + 1,
    );
    expect(backwardsReturn.after.state).toMatchObject({
      decision: { kind: "wait" },
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });

    await recheck(chargeMoney(100, 101), 104);
    const changedCapture = await recheck(chargeMoney(200, 201), 105);
    expect(changedCapture.after.revision).toBe(
      changedCapture.before.revision + 1,
    );
    expect(changedCapture.after.state).toMatchObject({
      decision: { captured: gbp(200), kind: "wait" },
      reason: "provider_conflict",
    });
  });
});
