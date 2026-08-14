import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import { DAY_MS } from "#shared/now.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority.ts";
import { REFUND_OBSERVATION_DELAY_MS } from "#shared/provider-refunds/state.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import {
  fakeRefundProvider,
  observingKeyedAuthority,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "./engine-helpers.ts";

describeWithEnv("provider refund engine sends", { db: true }, () => {
  for (const unfinished of ["send_armed", "observing"] as const) {
    test(`an observation-only check escalates a due keyless ${unfinished} generation`, async () => {
      const payment = refundReference(`txn-observe-due-${unfinished}`);
      let now = 100;
      let sends = 0;
      const provider = fakeRefundProvider(
        "sumup",
        () => Promise.resolve(foundCharge()),
        () => {
          sends++;
          if (unfinished === "send_armed") {
            throw new Error("provider process crashed");
          }
          return Promise.resolve({
            kind: "uncertain",
            reason: "network_error",
          });
        },
      );
      const dependencies = refundDependencies(provider, () => now);
      const first = requestProviderRefund(
        sendRefundTarget(payment),
        dependencies,
      );
      if (unfinished === "send_armed") {
        await expect(first).rejects.toThrow("provider process crashed");
      } else {
        expect(await first).toMatchObject({
          kind: "pending",
          state: "observing",
        });
      }

      now += REFUND_OBSERVATION_DELAY_MS;
      expect(
        await requestProviderRefund(
          {
            evidence: { charge: chargeMoney(), kind: "observed" },
            mode: "observe_only",
            reference: payment,
          },
          dependencies,
        ),
      ).toMatchObject({
        kind: "needs_owner_choice",
        reason: "possibly_sent",
      });
      expect(sends).toBe(1);
      expect(
        await storedRefundAuthority(await paymentReferenceIndex(payment)),
      ).toMatchObject({ refund_state_name: "needs_owner_choice" });
    });
  }

  test("an observation-only check never replays and escalates an expired keyed generation", async () => {
    const payment = refundReference("txn-observe-keyed", "stripe");
    let now = 100;
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      () => {
        sends++;
        return Promise.resolve({ kind: "uncertain", reason: "network_error" });
      },
    );
    const dependencies = refundDependencies(provider, () => now);

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "pending", state: "observing" });
    now += REFUND_OBSERVATION_DELAY_MS;
    expect(
      await requestProviderRefund(
        {
          evidence: { charge: chargeMoney(), kind: "observed" },
          mode: "observe_only",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({ kind: "pending", state: "observing" });
    expect(sends).toBe(1);

    now = 100 + DAY_MS + 1;
    expect(
      await requestProviderRefund(
        {
          evidence: { charge: chargeMoney(), kind: "observed" },
          mode: "observe_only",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "replay_window_expired",
    });
    expect(sends).toBe(1);
  });

  test("one keyless generation is sent once and later evidence completes it", async () => {
    const payment = refundReference("txn-one-send");
    let returned = false;
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () =>
        Promise.resolve(
          foundCharge(returned ? fullyRefundedMoney() : chargeMoney()),
        ),
      () => {
        sends++;
        return Promise.resolve({ kind: "uncertain", reason: "network_error" });
      },
    );
    const dependencies = refundDependencies(provider);
    const target = sendRefundTarget(payment, "checkout-one");

    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect(sends).toBe(1);

    returned = true;
    const completed = await requestProviderRefund(target, dependencies);
    expect(completed).toMatchObject({ kind: "returned", local: "due" });
    expect(sends).toBe(1);
    if (completed.kind !== "returned") {
      throw new Error("Expected a returned refund authority");
    }
    await recordProviderRefunds([completed.authority], 200);
    expect(
      await storedRefundAuthority(completed.authority.referenceIndex),
    ).toMatchObject({
      refund_local_state: "recorded",
      refund_state_name: "completed",
      refunded_amount: 1_000,
    });
  });

  test("a crash after durable arming never repeats a keyless provider call", async () => {
    const payment = refundReference("txn-crash");
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => {
        sends++;
        throw new Error("provider process crashed");
      },
    );
    const dependencies = refundDependencies(provider);
    const target = sendRefundTarget(payment, "checkout-crash");

    await expect(requestProviderRefund(target, dependencies)).rejects.toThrow(
      "provider process crashed",
    );
    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect(sends).toBe(1);
  });

  test("refuses before sending when its result cannot be persisted", async () => {
    const payment = refundReference("txn-result-reserve", "stripe");
    let sends = 0;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      () => {
        sends++;
        return Promise.resolve({ kind: "not_sent", reason: "not_configured" });
      },
    );
    const target = sendRefundTarget(payment);
    const dependencies = refundDependencies(provider);

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "ready",
    });
    sends = 0;

    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          { database: 2, external: 10, total: 12 },
          () => requestProviderRefund(target, dependencies),
        )
      ),
    ).rejects.toThrow("Subrequest reserve unavailable");
    expect(sends).toBe(0);
    expect(
      await storedRefundAuthority(await paymentReferenceIndex(payment)),
    ).toMatchObject({ refund_state_name: "ready" });
  });

  test("arms the exact observation deadline before the provider call", async () => {
    const now = 100;
    const payment = refundReference("txn-armed-deadline", "stripe");
    const index = await paymentReferenceIndex(payment);
    let armedState: RefundAuthorityState | undefined;
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      async () => {
        armedState = (await loadRefundAuthorityByReference(index))?.state;
        return { kind: "not_sent", reason: "not_configured" };
      },
    );

    await requestProviderRefund(
      sendRefundTarget(payment),
      refundDependencies(provider, () => now),
    );

    expect(armedState).toMatchObject({
      evidenceRevision: 1,
      kind: "send_armed",
      nextActionAt: now + REFUND_OBSERVATION_DELAY_MS,
    });
    expect((await loadRefundAuthorityByReference(index))?.state).toMatchObject({
      evidenceRevision: 2,
      kind: "ready",
      nextActionAt: now,
    });
  });

  test("replays one keyed generation exactly when its observation is due", async () => {
    let now = 100;
    let sends = 0;
    let rearmedState: RefundAuthorityState | undefined;
    const payment = refundReference("txn-keyed-replay", "stripe");
    const index = await paymentReferenceIndex(payment);
    const provider = fakeRefundProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      async () => {
        sends++;
        if (sends === 2) {
          rearmedState = (await loadRefundAuthorityByReference(index))?.state;
        }
        return { kind: "not_sent", reason: "not_configured" };
      },
    );
    const target = sendRefundTarget(payment);
    const dependencies = refundDependencies(provider, () => now);

    await requestProviderRefund(target, dependencies);
    await observingKeyedAuthority(index, 110, 200);
    now = 199;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "pending",
      state: "observing",
    });
    expect(sends).toBe(1);

    now = 200;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "ready",
    });
    expect(sends).toBe(2);
    expect(rearmedState).toMatchObject({
      kind: "send_armed",
      nextActionAt: now + REFUND_OBSERVATION_DELAY_MS,
    });
  });

  test("concurrent callers share the revision-fenced send", async () => {
    const payment = refundReference("txn-race");
    let sends = 0;
    const provider = fakeRefundProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => {
        sends++;
        return Promise.resolve({
          kind: "uncertain",
          reason: "network_error",
        });
      },
    );
    const dependencies = refundDependencies(provider);
    const target = sendRefundTarget(payment, "checkout-race");

    await Promise.all([
      requestProviderRefund(target, dependencies),
      requestProviderRefund(target, dependencies),
    ]);
    expect(sends).toBe(1);
  });
});
