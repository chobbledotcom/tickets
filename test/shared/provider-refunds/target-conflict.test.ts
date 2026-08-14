import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { resolveProviderRefundCase } from "#shared/db/provider-refund-case-resolution.ts";
import { loadProviderRefundCase } from "#shared/db/provider-refund-cases.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  chargeMoneyWith,
  completedRefund,
  foundCharge,
  refundObservation,
} from "#test-utils/payment-state.ts";
import {
  completingProviderThatReads,
  fakeRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
  validatedRefundTarget,
} from "./engine-helpers.ts";

describeWithEnv("provider refund conflict recovery", { db: true }, () => {
  test("a not-sent choice adopts exact conflict money before retrying", async () => {
    const target = validatedRefundTarget(
      "txn-callback-mismatch-retry",
      "checkout-callback-mismatch-retry",
    );
    const observed = chargeMoney(2_000);
    const refunding = completingProviderThatReads(() =>
      Promise.resolve(foundCharge(observed))
    );
    const dependencies = refundDependencies(refunding.provider);

    const conflict = await requestProviderRefund(target, dependencies);
    expect(conflict).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
    if (conflict.kind !== "needs_owner_choice") {
      throw new Error("Expected a provider-conflict owner choice");
    }
    expect(
      await resolveProviderRefundCase({
        activityMessage: "Owner confirmed the conflicting refund was not sent",
        choice: "provider_confirmed_not_sent",
        id: conflict.authority.id,
        privateKey: await getTestPrivateKey(),
        revision: conflict.authority.revision,
      }),
    ).toBe("resolved");

    expect(
      await requestProviderRefund(
        sendRefundTarget(target.reference),
        dependencies,
      ),
    ).toMatchObject({ kind: "returned", local: "due" });
    expect(refunding.sendCount()).toBe(1);
    expect(
      await storedRefundAuthority(
        await paymentReferenceIndex(target.reference),
      ),
    ).toMatchObject({ captured_amount: 2_000, refunded_amount: 2_000 });
  });

  test("waiting conflict evidence can be rechecked into a valid choice", async () => {
    const payment = refundReference("txn-conflict-recheck", "stripe");
    let observed = chargeMoneyWith({
      refunds: [
        refundObservation({
          amount: { amount: 10, currency: "GBP" },
          status: "pending",
        }),
        refundObservation({
          amount: { amount: 10, currency: "GBP" },
          status: "pending",
        }),
      ],
    });
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge(observed)),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );
    const dependencies = refundDependencies(provider);

    const waiting = await requestProviderRefund(
      validatedRefundTarget(
        payment.reference,
        "checkout-conflict-recheck",
        observed.captured,
      ),
      dependencies,
    );
    expect(waiting).toMatchObject({
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });
    if (waiting.kind !== "needs_provider_check") {
      throw new Error("Expected waiting provider-conflict work");
    }
    expect(
      await loadProviderRefundCase(
        waiting.authority.id,
        await getTestPrivateKey(),
      ),
    ).toMatchObject({ decision: { kind: "wait" } });

    observed = chargeMoney(100);
    const rechecked = await requestProviderRefund(
      {
        evidence: { kind: "read_provider" },
        mode: "observe_only",
        reference: payment,
      },
      dependencies,
    );
    expect(rechecked).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
    if (rechecked.kind !== "needs_owner_choice") {
      throw new Error("Expected a rechecked provider-conflict choice");
    }
    expect(
      await loadProviderRefundCase(
        rechecked.authority.id,
        await getTestPrivateKey(),
      ),
    ).toMatchObject({
      decision: {
        captured: { amount: 100, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      },
    });

    observed = chargeMoney(100, 100);
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
      authority: { revision: rechecked.authority.revision },
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
  });

  test("partial returned money cannot be forgotten by later provider reads", async () => {
    const payment = refundReference("txn-partial-return-floor", "stripe");
    let observed = chargeMoney(2_500, 400);
    let sendCount = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge(observed)),
      (request) => {
        sendCount++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const dependencies = refundDependencies(provider);

    const partial = await requestProviderRefund(
      sendRefundTarget(payment),
      dependencies,
    );
    expect(partial).toMatchObject({
      kind: "needs_provider_check",
      reason: "provider_conflict",
    });
    if (partial.kind !== "needs_provider_check") {
      throw new Error("Expected a partial-return provider conflict");
    }

    observed = chargeMoney(2_500, 2_501);
    const invalid = await requestProviderRefund(
      {
        evidence: { kind: "read_provider" },
        mode: "observe_only",
        reference: payment,
      },
      dependencies,
    );
    expect(invalid).toMatchObject({ kind: "needs_provider_check" });

    observed = chargeMoney(2_500);
    const backwards = await requestProviderRefund(
      {
        evidence: { kind: "read_provider" },
        mode: "observe_only",
        reference: payment,
      },
      dependencies,
    );
    expect(backwards).toMatchObject({ kind: "needs_provider_check" });
    if (backwards.kind !== "needs_provider_check") {
      throw new Error("Expected partial-return evidence to remain protected");
    }
    expect(
      await loadProviderRefundCase(
        backwards.authority.id,
        await getTestPrivateKey(),
      ),
    ).toMatchObject({
      decision: { kind: "wait" },
      state: "needs_provider_check",
    });
    expect(
      await resolveProviderRefundCase({
        activityMessage: "A stale zero read cannot authorize another refund",
        choice: "provider_confirmed_not_sent",
        id: backwards.authority.id,
        privateKey: await getTestPrivateKey(),
        revision: backwards.authority.revision,
      }),
    ).toBe("changed");
    expect(
      await storedRefundAuthority(await paymentReferenceIndex(payment)),
    ).toMatchObject({
      refunded_amount: 400,
      refund_local_state: "not_due",
      refund_state_name: "needs_provider_check",
    });
    expect(sendCount).toBe(0);
  });
});
