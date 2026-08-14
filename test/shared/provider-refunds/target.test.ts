import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import { REFUND_OBSERVATION_DELAY_MS } from "#shared/provider-refunds/state.ts";
import {
  type ProviderRefundDependencies,
  type ProviderRefundTarget,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { chargeMoney, foundCharge } from "#test-utils/payment-state.ts";
import {
  completingProviderThatReads,
  completingRefundProvider,
  fakeRefundProvider,
  notSentRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
  validatedRefundTarget,
} from "./engine-helpers.ts";

const expectOwnerChoice = async (
  target: ProviderRefundTarget,
  dependencies: ProviderRefundDependencies,
  reason: "provider_conflict" | "provider_unreadable",
) => {
  expect(await requestProviderRefund(target, dependencies)).toMatchObject({
    kind: "needs_owner_choice",
    reason,
  });
};

describeWithEnv("provider refund target authority", { db: true }, () => {
  test("a temporarily unavailable validated callback recovers through the same authority", async () => {
    const target = validatedRefundTarget(
      "txn-unreadable",
      "checkout-unreadable",
    );
    let available = false;
    const refunding = completingProviderThatReads(() =>
      Promise.resolve(
        available
          ? foundCharge()
          : { reason: "timeout", status: "unavailable" },
      ),
    );
    const dependencies = refundDependencies(refunding.provider);

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "withheld",
    });
    const index = await paymentReferenceIndex(target.reference);
    const waiting = await storedRefundAuthority(index);
    expect(waiting).toMatchObject({
      callback_replay_index: await refundCallbackReplayIndex(
        "stripe",
        target.callbackSessionId,
      ),
      captured_amount: 1_000,
      refund_state_name: "ready",
    });
    expect(refunding.sendCount()).toBe(0);

    available = true;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "returned",
      local: "due",
    });
    expect(refunding.sendCount()).toBe(1);
    expect(await storedRefundAuthority(index)).toMatchObject({
      refund_state_name: "completed",
    });
  });

  for (const [name, read] of [
    ["missing", { status: "missing" }],
    ["invalid", { reason: "missing_documented_resource", status: "invalid" }],
  ] as const) {
    test(`${name} callback evidence requires an owner choice without sending`, async () => {
      const target = validatedRefundTarget(
        `txn-${name}-callback`,
        `checkout-${name}-callback`,
      );
      const refunding = completingProviderThatReads(() =>
        Promise.resolve(read),
      );

      await expectOwnerChoice(
        target,
        refundDependencies(refunding.provider),
        "provider_unreadable",
      );
      expect(refunding.sendCount()).toBe(0);
      expect(
        await storedRefundAuthority(
          await paymentReferenceIndex(target.reference),
        ),
      ).toMatchObject({ refund_state_name: "needs_owner_choice" });
    });
  }

  test("persistent provider unavailability has one finite owner-choice deadline", async () => {
    const target = validatedRefundTarget(
      "txn-unavailable-deadline",
      "checkout-unavailable-deadline",
    );
    let now = 100;
    const refunding = completingProviderThatReads(() =>
      Promise.resolve({ reason: "timeout", status: "unavailable" }),
    );
    const dependencies = refundDependencies(refunding.provider, () => now);

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "withheld",
    });
    now += REFUND_OBSERVATION_DELAY_MS;
    await expectOwnerChoice(target, dependencies, "provider_unreadable");
    expect(refunding.sendCount()).toBe(0);
  });

  test("an unreadable due keyless attempt reaches its required owner choice", async () => {
    const payment = refundReference("txn-unreadable-after-send");
    let now = 100;
    let unavailable = false;
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () =>
        Promise.resolve(
          unavailable
            ? { reason: "timeout", status: "unavailable" }
            : foundCharge(),
        ),
      () => {
        sends++;
        return Promise.resolve({ kind: "uncertain", reason: "network_error" });
      },
    );
    const dependencies = refundDependencies(provider, () => now);

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "pending", state: "observing" });
    unavailable = true;
    now += REFUND_OBSERVATION_DELAY_MS;
    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
    expect(sends).toBe(1);
  });

  test("provider money contradicting the callback requires an owner choice", async () => {
    const target = validatedRefundTarget(
      "txn-callback-mismatch",
      "checkout-callback-mismatch",
    );
    const refunding = completingProviderThatReads(() =>
      Promise.resolve(foundCharge(chargeMoney(2_000))),
    );

    await expectOwnerChoice(
      target,
      refundDependencies(refunding.provider),
      "provider_conflict",
    );
    expect(refunding.sendCount()).toBe(0);
    expect(
      await storedRefundAuthority(
        await paymentReferenceIndex(target.reference),
      ),
    ).toMatchObject({
      captured_amount: 1_000,
      refund_state_name: "needs_owner_choice",
      refunded_amount: 0,
    });
  });

  test("callback money cannot replace an existing charge amount", async () => {
    const payment = refundReference("txn-existing-money", "stripe");
    let reads = 0;
    const refunding = notSentRefundProvider("stripe", () => {
      reads++;
      return Promise.resolve(foundCharge(chargeMoney(2_000)));
    });
    const dependencies = refundDependencies(refunding.provider);

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "ready" });
    await expectOwnerChoice(
      validatedRefundTarget(payment.reference, "checkout-existing-money"),
      dependencies,
      "provider_conflict",
    );
    expect(reads).toBe(2);
    expect(refunding.sendCount()).toBe(1);
  });

  test("a callback binds an admin-created terminal authority before returning", async () => {
    const payment = refundReference("txn-late-callback", "stripe");
    let providerLoads = 0;
    const provider = completingRefundProvider("stripe");
    const dependencies = {
      loadProvider: () => {
        providerLoads++;
        return Promise.resolve(provider);
      },
      now: () => 100,
    };

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "returned" });
    expect(
      (await storedRefundAuthority(await paymentReferenceIndex(payment)))
        ?.callback_replay_index,
    ).toBeNull();

    expect(
      await requestProviderRefund(
        validatedRefundTarget(payment.reference, "checkout-late-callback"),
        dependencies,
      ),
    ).toMatchObject({ kind: "returned" });
    expect(
      (await storedRefundAuthority(await paymentReferenceIndex(payment)))
        ?.callback_replay_index,
    ).toBe(await refundCallbackReplayIndex("stripe", "checkout-late-callback"));
    expect(providerLoads).toBe(1);
  });

  test("one callback identity cannot reach a different charge", async () => {
    const first = refundReference("txn-callback-owner", "stripe");
    const provider = completingRefundProvider("stripe");
    const dependencies = refundDependencies(provider);
    await requestProviderRefund(sendRefundTarget(first), dependencies);
    await requestProviderRefund(
      validatedRefundTarget(first.reference, "checkout-one-owner"),
      dependencies,
    );

    let laterProviderLoads = 0;
    await expect(
      requestProviderRefund(
        validatedRefundTarget("txn-callback-intruder", "checkout-one-owner"),
        {
          loadProvider: () => {
            laterProviderLoads++;
            return Promise.resolve(provider);
          },
          now: () => 200,
        },
      ),
    ).rejects.toThrow("Refund callback identity belongs to another charge");
    expect(laterProviderLoads).toBe(0);
  });

  test("concurrent validated charges cannot share one callback or leave phantom work", async () => {
    const refunding = completingProviderThatReads(() =>
      Promise.resolve(foundCharge()),
    );
    const callbackSessionId = "checkout-new-charge-race";
    const ask = (raw: string) =>
      requestProviderRefund(validatedRefundTarget(raw, callbackSessionId), {
        loadProvider: () => Promise.resolve(refunding.provider),
        now: () => 100,
      });

    const results = await Promise.allSettled([
      ask("txn-new-race-one"),
      ask("txn-new-race-two"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toContain(
      "Refund callback identity belongs to another charge",
    );
    expect(refunding.sendCount()).toBe(1);
    expect(
      await queryAll<{
        callback_replay_index: string | null;
        refund_state_name: string;
      }>(
        `SELECT callback_replay_index, refund_state_name
           FROM payment_charges`,
      ),
    ).toEqual([
      {
        callback_replay_index: await refundCallbackReplayIndex(
          "stripe",
          callbackSessionId,
        ),
        refund_state_name: "completed",
      },
    ]);
  });
});
