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
      Promise.resolve(foundCharge(observed)),
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
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
    if (waiting.kind !== "needs_owner_choice") {
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
  });
});
