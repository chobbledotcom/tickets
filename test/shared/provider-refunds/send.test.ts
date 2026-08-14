import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { loadRefundAuthorityByReference } from "#shared/db/provider-refund-authority.ts";
import { DAY_MS } from "#shared/now.ts";
import { admitObservedRefund } from "#shared/payment/admit-refund.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { armReadyRefund } from "#shared/provider-refunds/send.ts";
import { REFUND_OBSERVATION_DELAY_MS } from "#shared/provider-refunds/state.ts";
import type {
  ProviderRefundDependencies,
  ProviderRefundResult,
  RefundEngineProvider,
} from "#shared/provider-refunds.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";
import {
  fakeRefundProvider,
  notSentRefundProvider,
  refundDependencies,
  refundReference,
  sendRefundTarget,
  storedRefundAuthority,
} from "./engine-helpers.ts";

const uncertainProvider = (
  provider: PaymentProviderType,
  onSend: () => void,
  readCharge: () => ChargeMoney = chargeMoney,
): RefundEngineProvider =>
  fakeRefundProvider(
    provider,
    () => Promise.resolve(foundCharge(readCharge())),
    () => {
      onSend();
      return Promise.resolve({ kind: "uncertain", reason: "network_error" });
    },
  );

interface SendCounter {
  count(): number;
  sent(): void;
}

const sendCounter = (): SendCounter => {
  let count = 0;
  return {
    count: () => count,
    sent: () => {
      count++;
    },
  };
};

const observeRefund = (
  reference: ReturnType<typeof refundReference>,
  charge: ChargeMoney,
  dependencies: ProviderRefundDependencies,
): Promise<ProviderRefundResult> =>
  requestProviderRefund(
    { evidence: { charge, kind: "observed" }, mode: "observe_only", reference },
    dependencies,
  );

const expectKeylessOwnerChoice = async (
  reference: ReturnType<typeof refundReference>,
  dependencies: ProviderRefundDependencies,
): Promise<void> => {
  const result = await observeRefund(reference, chargeMoney(), dependencies);
  expect(result).toMatchObject({
    kind: "needs_owner_choice",
    reason: "possibly_sent",
  });
};

describeWithEnv("provider refund engine sends", { db: true }, () => {
  for (const unfinished of ["send_armed", "observing"] as const) {
    test(`an observation-only check escalates a due keyless ${unfinished} generation`, async () => {
      const payment = refundReference(`txn-observe-due-${unfinished}`);
      let now = 100;
      const sends = sendCounter();
      const recordSend = () => {
        sends.sent();
        if (unfinished === "send_armed") {
          throw new Error("provider process crashed");
        }
      };
      const provider = uncertainProvider("sumup", recordSend);
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
      await expectKeylessOwnerChoice(payment, dependencies);
      expect(sends.count()).toBe(1);
      expect(
        await storedRefundAuthority(await paymentReferenceIndex(payment)),
      ).toMatchObject({ refund_state_name: "needs_owner_choice" });
    });
  }

  test("an observation-only check never replays and escalates an expired keyed generation", async () => {
    const payment = refundReference("txn-observe-keyed", "stripe");
    let now = 100;
    const sends = sendCounter();
    const provider = uncertainProvider("stripe", sends.sent);
    const dependencies = refundDependencies(provider, () => now);

    expect(
      await requestProviderRefund(sendRefundTarget(payment), dependencies),
    ).toMatchObject({ kind: "pending", state: "observing" });
    now += REFUND_OBSERVATION_DELAY_MS;
    const pending = await observeRefund(payment, chargeMoney(), dependencies);
    expect(pending).toMatchObject({ kind: "pending", state: "observing" });
    expect(sends.count()).toBe(1);

    now = 100 + DAY_MS + 1;
    const expired = await observeRefund(payment, chargeMoney(), dependencies);
    expect(expired).toMatchObject({
      kind: "needs_owner_choice",
      reason: "replay_window_expired",
    });
    expect(sends.count()).toBe(1);
  });

  test("one keyless generation is sent once and later evidence completes it", async () => {
    const payment = refundReference("txn-one-send");
    let returned = false;
    const sends = sendCounter();
    function currentCharge(): ChargeMoney {
      return returned ? fullyRefundedMoney() : chargeMoney();
    }
    const read = currentCharge;
    const provider = uncertainProvider("sumup", sends.sent, read);
    const dependencies = refundDependencies(provider);
    const target = sendRefundTarget(payment, "checkout-one");

    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect(sends.count()).toBe(1);

    returned = true;
    const completed = await requestProviderRefund(target, dependencies);
    expect(completed).toMatchObject({ kind: "returned", local: "due" });
    expect(sends.count()).toBe(1);
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

  test("later proof retires a keyless owner decision without another send", async () => {
    const payment = refundReference("txn-owner-proof");
    let now = 100;
    const sends = sendCounter();
    const provider = uncertainProvider("sumup", sends.sent);
    const dependencies = refundDependencies(provider, () => now);

    expect(
      await requestProviderRefund(
        sendRefundTarget(payment, "checkout-owner-proof"),
        dependencies,
      ),
    ).toMatchObject({ kind: "pending", state: "observing" });
    now += REFUND_OBSERVATION_DELAY_MS;
    await expectKeylessOwnerChoice(payment, dependencies);

    expect(
      await observeRefund(payment, chargeMoney(), dependencies),
    ).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });
    const completed = await observeRefund(
      payment,
      fullyRefundedMoney(),
      dependencies,
    );
    expect(completed).toMatchObject({ kind: "returned", local: "due" });
    expect(sends.count()).toBe(1);
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
    const refunding = notSentRefundProvider("stripe");
    const target = sendRefundTarget(payment);
    const dependencies = refundDependencies(refunding.provider);
    const requestRefund = () => requestProviderRefund(target, dependencies);
    const requestWithoutResultReserve = () =>
      withSubrequestAllowance(
        { database: 2, external: 10, total: 12 },
        requestRefund,
      );

    expect(await requestRefund()).toMatchObject({
      kind: "ready",
    });
    expect(refunding.sendCount()).toBe(1);

    const refused = runWithSubrequestBudget(requestWithoutResultReserve);
    await expect(refused).rejects.toThrow("Subrequest reserve unavailable");
    expect(refunding.sendCount()).toBe(1);
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
        return sends === 1
          ? { kind: "uncertain", reason: "network_error" }
          : { kind: "not_sent", reason: "not_configured" };
      },
    );
    const target = sendRefundTarget(payment);
    const dependencies = refundDependencies(provider, () => now);

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "pending",
      state: "observing",
    });
    const replayAt = now + REFUND_OBSERVATION_DELAY_MS;
    now = replayAt - 1;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "pending",
      state: "observing",
    });
    expect(sends).toBe(1);

    now = replayAt;
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
        return Promise.resolve(
          sends === 1
            ? { kind: "not_sent", reason: "not_configured" }
            : { kind: "uncertain", reason: "network_error" },
        );
      },
    );
    const dependencies = refundDependencies(provider);
    const target = sendRefundTarget(payment);

    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "ready",
    });
    const row = await loadRefundAuthorityByReference(
      await paymentReferenceIndex(payment),
    );
    if (row === null) throw new Error("Expected a ready refund authority");
    const charge = chargeMoney();
    const work = {
      admission: admitObservedRefund(payment.reference, charge),
      charge,
      now: 200,
      provider,
      row,
      target,
    };

    const answers = await Promise.all([
      armReadyRefund(work),
      armReadyRefund(work),
    ]);
    expect(answers.every((answer) => answer.kind === "pending")).toBe(true);
    expect(sends).toBe(2);
  });
});
