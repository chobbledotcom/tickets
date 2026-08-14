import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import { requestProviderRefund } from "#shared/provider-refunds.ts";
import { REFUND_OBSERVATION_DELAY_MS } from "#shared/provider-refunds/state.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
} from "#test-utils/payment-state.ts";
import {
  completingRefundProvider,
  fakeRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "./engine-helpers.ts";

const validatedTarget = (
  raw: string,
  callbackSessionId: string,
  captured = chargeMoney().captured,
) => ({
  callbackSessionId,
  evidence: { captured, kind: "validated_callback" as const },
  mode: "send" as const,
  reference: refundReference(raw, "stripe"),
});

describeWithEnv("provider refund target authority", { db: true }, () => {
  test("a temporarily unavailable validated callback recovers through the same authority", async () => {
    const target = validatedTarget("txn-unreadable", "checkout-unreadable");
    let available = false;
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () =>
        Promise.resolve(
          available
            ? foundCharge()
            : { reason: "timeout", status: "unavailable" },
        ),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => 100,
    };

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
    expect(sends).toBe(0);

    available = true;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "returned",
      local: "due",
    });
    expect(sends).toBe(1);
    expect(await storedRefundAuthority(index)).toMatchObject({
      refund_state_name: "completed",
    });
  });

  for (const [name, read] of [
    ["missing", { status: "missing" }],
    ["invalid", { reason: "missing_amount", status: "invalid" }],
  ] as const) {
    test(`${name} callback evidence requires an owner choice without sending`, async () => {
      const target = validatedTarget(
        `txn-${name}-callback`,
        `checkout-${name}-callback`,
      );
      let sends = 0;
      const provider = fakeRefundProvider(
        "stripe",
        () => Promise.resolve(read),
        (request) => {
          sends++;
          return Promise.resolve(completedRefund(request.charge));
        },
      );

      expect(
        await requestProviderRefund(target, {
          loadProvider: () => Promise.resolve(provider),
          now: () => 100,
        }),
      ).toMatchObject({
        kind: "needs_owner_choice",
        reason: "provider_unreadable",
      });
      expect(sends).toBe(0);
      expect(
        await storedRefundAuthority(
          await paymentReferenceIndex(target.reference),
        ),
      ).toMatchObject({ refund_state_name: "needs_owner_choice" });
    });
  }

  test("persistent provider unavailability has one finite owner-choice deadline", async () => {
    const target = validatedTarget(
      "txn-unavailable-deadline",
      "checkout-unavailable-deadline",
    );
    let now = 100;
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve({ reason: "timeout", status: "unavailable" }),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => now,
    };

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "withheld",
    });
    now += REFUND_OBSERVATION_DELAY_MS;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_unreadable",
    });
    expect(sends).toBe(0);
  });

  test("provider money contradicting the callback requires an owner choice", async () => {
    const target = validatedTarget(
      "txn-callback-mismatch",
      "checkout-callback-mismatch",
    );
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge(chargeMoney(2_000))),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );

    expect(
      await requestProviderRefund(target, {
        loadProvider: () => Promise.resolve(provider),
        now: () => 100,
      }),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
    expect(sends).toBe(0);
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
        validatedTarget(payment.reference, "checkout-late-callback"),
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
      validatedTarget(first.reference, "checkout-one-owner"),
      dependencies,
    );

    let laterProviderLoads = 0;
    await expect(
      requestProviderRefund(
        validatedTarget("txn-callback-intruder", "checkout-one-owner"),
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
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const callbackSessionId = "checkout-new-charge-race";
    const ask = (raw: string) =>
      requestProviderRefund(validatedTarget(raw, callbackSessionId), {
        loadProvider: () => Promise.resolve(provider),
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
    expect(sends).toBe(1);
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
