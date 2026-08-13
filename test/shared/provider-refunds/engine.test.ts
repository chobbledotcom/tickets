import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { AuthorizedRefundRequest } from "#shared/payment/refund-provider-authorization.ts";
import { refundCallbackReplayIndex } from "#shared/payment/refund-request-identity.ts";
import type { RefundEngineProvider } from "#shared/provider-refunds.ts";
import {
  recordProviderRefunds,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  chargeMoney,
  completedRefund,
  foundCharge,
  fullyRefundedMoney,
} from "#test-utils/payment-state.ts";

const reference = (
  raw: string,
  provider: PaymentProviderType = "sumup",
): TaggedPaymentReference => ({ kind: "tagged", provider, reference: raw });

const fakeProvider = (
  provider: PaymentProviderType,
  read: () => ReturnType<RefundEngineProvider["readCharge"]>,
  send: (
    request: AuthorizedRefundRequest,
  ) => ReturnType<RefundEngineProvider["refundCharge"]>,
): RefundEngineProvider => ({
  readCharge: read,
  refundCapability: provider === "sumup" ? "keyless" : "keyed",
  refundCharge: send,
  type: provider,
});

const storedAuthority = (index: string) =>
  queryOne<{
    callback_replay_index: string | null;
    provider_reference: string;
    refunded_amount: number;
    refund_local_state: string;
    refund_revision: number;
    refund_state_name: string;
  }>(
    `SELECT callback_replay_index, provider_reference, refunded_amount,
            refund_local_state, refund_revision, refund_state_name
       FROM payment_charges
      WHERE reference_index = ?`,
    [index],
  );

describeWithEnv("provider refund engine", { db: true }, () => {
  test("one keyless generation is sent once and later evidence completes it", async () => {
    const payment = reference("txn-one-send");
    let returned = false;
    let sends = 0;
    const provider = fakeProvider(
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
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => 100,
    };
    const target = {
      callbackSessionId: "checkout-one",
      evidence: { kind: "read_provider" as const },
      mode: "send" as const,
      reference: payment,
    };

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
    if (completed.kind !== "returned" || completed.authority === null) {
      throw new Error("Expected a returned refund authority");
    }
    await recordProviderRefunds([completed.authority], 200);
    expect(
      await storedAuthority(completed.authority.referenceIndex),
    ).toMatchObject({
      refund_local_state: "recorded",
      refund_state_name: "completed",
      refunded_amount: 1_000,
    });
  });

  test("a crash after durable arming never repeats a keyless provider call", async () => {
    const payment = reference("txn-crash");
    let sends = 0;
    const provider = fakeProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => {
        sends++;
        throw new Error("provider process crashed");
      },
    );
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => 100,
    };
    const target = {
      callbackSessionId: "checkout-crash",
      evidence: { kind: "read_provider" as const },
      mode: "send" as const,
      reference: payment,
    };

    await expect(requestProviderRefund(target, dependencies)).rejects.toThrow(
      "provider process crashed",
    );
    expect((await requestProviderRefund(target, dependencies)).kind).toBe(
      "pending",
    );
    expect(sends).toBe(1);
  });

  test("concurrent callers share the revision-fenced send", async () => {
    const payment = reference("txn-race");
    let sends = 0;
    const provider = fakeProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      async () => {
        sends++;
        return { kind: "uncertain", reason: "network_error" };
      },
    );
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => 100,
    };
    const target = {
      callbackSessionId: "checkout-race",
      evidence: { kind: "read_provider" as const },
      mode: "send" as const,
      reference: payment,
    };

    await Promise.all([
      requestProviderRefund(target, dependencies),
      requestProviderRefund(target, dependencies),
    ]);
    expect(sends).toBe(1);
  });

  test("already-returned evidence stores no DB-key-readable provider id", async () => {
    const payment = reference("txn-owner-only");
    const provider = fakeProvider(
      "sumup",
      () => Promise.resolve(foundCharge(fullyRefundedMoney())),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );

    expect(
      await requestProviderRefund(
        {
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: payment,
        },
        { loadProvider: () => Promise.resolve(provider), now: () => 100 },
      ),
    ).toMatchObject({ kind: "returned", local: "due" });
    const index = await paymentReferenceIndex(payment);
    const stored = await storedAuthority(index);
    expect(stored?.provider_reference.startsWith("hyb:1:")).toBe(true);
    expect(stored?.provider_reference).not.toContain(payment.reference);
  });

  test("a provider conflict becomes a durable owner choice", async () => {
    const payment = reference("txn-conflict", "stripe");
    const conflicting = chargeMoney(1_000, 100);
    const provider = fakeProvider(
      "stripe",
      () => Promise.resolve(foundCharge(conflicting)),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );
    const answer = await requestProviderRefund(
      {
        evidence: { kind: "read_provider" },
        mode: "send",
        reference: payment,
      },
      { loadProvider: () => Promise.resolve(provider), now: () => 100 },
    );

    expect(answer).toMatchObject({
      kind: "needs_owner_choice",
      reason: "provider_conflict",
    });
  });

  test("observation records fresh evidence without arming a send", async () => {
    const payment = reference("txn-observe-only");
    let sends = 0;
    const provider = fakeProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const answer = await requestProviderRefund(
      {
        evidence: { charge: chargeMoney(), kind: "observed" },
        mode: "observe_only",
        reference: payment,
      },
      { loadProvider: () => Promise.resolve(provider), now: () => 100 },
    );

    expect(answer.kind).toBe("ready");
    expect(sends).toBe(0);
  });

  test("a completed send marks matching processed rows before returning", async () => {
    const payment = reference("txn-marker", "stripe");
    const index = await paymentReferenceIndex(payment);
    await getDb().execute({
      args: [index],
      sql: `INSERT INTO processed_payments
        (payment_session_id, processed_at, payment_reference_index)
        VALUES ('session-marker', '2026-08-13T00:00:00.000Z', ?)`,
    });
    const provider = fakeProvider(
      "stripe",
      () => Promise.resolve(foundCharge()),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );

    expect(
      await requestProviderRefund(
        {
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: payment,
        },
        { loadProvider: () => Promise.resolve(provider), now: () => 100 },
      ),
    ).toMatchObject({ kind: "returned" });
    expect(
      await queryOne<{ provider_refunded_at: string }>(
        `SELECT provider_refunded_at FROM processed_payments
          WHERE payment_session_id = 'session-marker'`,
      ),
    ).toEqual({ provider_refunded_at: "1970-01-01T00:00:00.100Z" });
  });

  test("a callback binds an admin-created terminal authority before returning", async () => {
    const payment = reference("txn-late-callback", "stripe");
    let providerLoads = 0;
    const provider = fakeProvider(
      "stripe",
      () => Promise.resolve(foundCharge(fullyRefundedMoney())),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );
    const dependencies = {
      loadProvider: () => {
        providerLoads++;
        return Promise.resolve(provider);
      },
      now: () => 100,
    };

    expect(
      await requestProviderRefund(
        {
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({ kind: "returned" });
    expect(
      (await storedAuthority(await paymentReferenceIndex(payment)))
        ?.callback_replay_index,
    ).toBeNull();

    expect(
      await requestProviderRefund(
        {
          callbackSessionId: "checkout-late-callback",
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: payment,
        },
        dependencies,
      ),
    ).toMatchObject({ kind: "returned" });
    expect(
      (await storedAuthority(await paymentReferenceIndex(payment)))
        ?.callback_replay_index,
    ).toBe(await refundCallbackReplayIndex("stripe", "checkout-late-callback"));
    expect(providerLoads).toBe(1);
  });

  test("one callback identity cannot reach a different charge", async () => {
    const first = reference("txn-callback-owner", "stripe");
    const provider = fakeProvider(
      "stripe",
      () => Promise.resolve(foundCharge(fullyRefundedMoney())),
      (request) => Promise.resolve(completedRefund(request.charge)),
    );
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => 100,
    };
    await requestProviderRefund(
      {
        evidence: { kind: "read_provider" },
        mode: "send",
        reference: first,
      },
      dependencies,
    );
    await requestProviderRefund(
      {
        callbackSessionId: "checkout-one-owner",
        evidence: { kind: "read_provider" },
        mode: "send",
        reference: first,
      },
      dependencies,
    );

    let laterProviderLoads = 0;
    await expect(
      requestProviderRefund(
        {
          callbackSessionId: "checkout-one-owner",
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: reference("txn-callback-intruder", "stripe"),
        },
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

  test("concurrent new charges cannot share one callback or leave phantom work", async () => {
    let reads = 0;
    let releaseReads = (): void => {
      throw new Error("Both callback reads did not start");
    };
    const bothReadsStarted = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let sends = 0;
    const provider = fakeProvider(
      "stripe",
      async () => {
        reads++;
        if (reads === 2) releaseReads();
        await bothReadsStarted;
        return foundCharge();
      },
      (request) => {
        sends++;
        return Promise.resolve(completedRefund(request.charge));
      },
    );
    const callbackSessionId = "checkout-new-charge-race";
    const request = (raw: string) =>
      requestProviderRefund(
        {
          callbackSessionId,
          evidence: { kind: "read_provider" },
          mode: "send",
          reference: reference(raw, "stripe"),
        },
        { loadProvider: () => Promise.resolve(provider), now: () => 100 },
      );

    const results = await Promise.allSettled([
      request("txn-new-race-one"),
      request("txn-new-race-two"),
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

  test("local recording refuses a stale receipt for unfinished money", async () => {
    const payment = reference("txn-stale-local-recording");
    let now = 100;
    const provider = fakeProvider(
      "sumup",
      () => Promise.resolve(foundCharge()),
      () => Promise.resolve({ kind: "uncertain", reason: "network_error" }),
    );
    const target = {
      evidence: { kind: "read_provider" as const },
      mode: "send" as const,
      reference: payment,
    };
    const dependencies = {
      loadProvider: () => Promise.resolve(provider),
      now: () => now,
    };
    const pending = await requestProviderRefund(target, dependencies);
    if (pending.kind !== "pending") {
      throw new Error("Expected the first refund attempt to remain pending");
    }
    now += 5 * 60 * 1_000;
    expect(await requestProviderRefund(target, dependencies)).toMatchObject({
      kind: "needs_owner_choice",
      reason: "possibly_sent",
    });

    await expect(recordProviderRefunds([pending.authority], now)).rejects
      .toThrow("Refund local-recording authority changed");
  });
});
