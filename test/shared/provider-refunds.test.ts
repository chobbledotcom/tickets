import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
  requestProviderRefunds,
} from "#shared/provider-refunds.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, foundCharge } from "#test-utils/payment-state.ts";
import {
  completingRefundProvider,
  fakeRefundProvider,
  notSentRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "./provider-refunds/engine-helpers.ts";

describeWithEnv("provider refund engine", { db: true }, () => {
  test("clean observations remain stateless for one or many charges", async () => {
    const provider = completingRefundProvider("sumup", chargeMoney());
    const payments = [
      refundReference("txn-clean-one"),
      refundReference("txn-clean-two"),
    ];
    const targets = payments.map((reference) => ({
      evidence: { charge: chargeMoney(), kind: "observed" as const },
      mode: "observe_only" as const,
      reference,
    }));
    const firstTarget = targets[0];
    if (firstTarget === undefined) throw new Error("First target is missing");

    expect(
      await requestProviderRefund(firstTarget, refundDependencies(provider)),
    ).toEqual({ kind: "unchanged", reference: payments[0] });
    expect(
      await requestProviderRefunds(targets, refundDependencies(provider)),
    ).toEqual(payments.map((reference) => ({ kind: "unchanged", reference })));
    expect(
      await Promise.all(
        payments.map(
          async (payment) =>
            await storedRefundAuthority(await paymentReferenceIndex(payment)),
        ),
      ),
    ).toEqual([null, null]);
  });

  test("an existing ready refund remains observation-only", async () => {
    const payment = refundReference("txn-ready-observation", "stripe");
    const refunding = notSentRefundProvider("stripe");
    const dependencies = refundDependencies(refunding.provider);

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "ready" });
    expect(
      await requestProviderRefund(
        {
          evidence: { charge: chargeMoney(), kind: "observed" },
          mode: "observe_only",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({ kind: "ready" });
    expect(refunding.sendCount()).toBe(1);
  });

  // A provider can no longer disagree with its own refund capability: the
  // capability is a column on the provider registry, read by the id, so the
  // only way a loader can contradict the stored identity is the id itself.
  test("refuses a loader returning another provider", async () => {
    await expect(
      requestProviderRefund(
        sendRefundTarget(refundReference("txn-wrong-provider", "stripe")),
        refundDependencies(completingRefundProvider("sumup")),
      ),
    ).rejects.toThrow("Refund provider does not match its durable identity");
  });

  test("a spent local-recording budget leaves returned money recoverable", async () => {
    const payment = refundReference("txn-record-budget");
    const dependencies = refundDependencies(
      completingRefundProvider("sumup", chargeMoney()),
    );
    const returned = await requestProviderRefund(
      sendRefundTarget(payment),
      dependencies,
    );
    if (returned.kind !== "returned") {
      throw new Error("Expected returned money before local recording");
    }

    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 1, external: 0, total: 1 }, () =>
          recordProviderRefunds([returned.authority], 200),
        ),
      ),
    ).rejects.toThrow("Subrequest allowance exceeded");
    expect(
      await storedRefundAuthority(returned.authority.referenceIndex),
    ).toMatchObject({
      refund_local_state: "due",
      refund_state_name: "completed",
    });

    await recordProviderRefunds([returned.authority], 201);
    const recorded = await storedRefundAuthority(
      returned.authority.referenceIndex,
    );
    expect(recorded).toMatchObject({
      refund_local_state: "recorded",
      refund_state_name: "completed",
    });
    await recordProviderRefunds([returned.authority], 202);
    expect(
      await storedRefundAuthority(returned.authority.referenceIndex),
    ).toEqual(recorded);
    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "returned", local: "recorded" });
  });

  test("local recording refuses a stale receipt for unfinished money", async () => {
    const payment = refundReference("txn-stale-local-recording");
    let now = 100;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => Promise.resolve({ kind: "uncertain", reason: "network_error" }),
    );
    const target = sendRefundTarget(payment);
    const dependencies = refundDependencies(provider, () => now);
    const pending = await requestProviderRefund(target, dependencies);
    if (pending.kind !== "pending") {
      throw new Error("Expected the first refund attempt to remain pending");
    }
    now += 5 * 60 * 1_000;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });

    await expect(
      recordProviderRefunds([pending.authority], now),
    ).rejects.toThrow("Refund local-recording authority changed");
  });
});
