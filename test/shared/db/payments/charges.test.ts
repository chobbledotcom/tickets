import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { getDb } from "#shared/db/client.ts";
import {
  applyChargeRefund,
  getPaymentCharges,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import type { ChargeLeg } from "#shared/payment-state/resources.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";
import { pendingRefundObservation } from "#test-utils/payment-refunds.ts";
import { insertLegacyPaymentCharge } from "./db-fixtures.ts";
import {
  CHARGE_RESOURCE,
  chargeLeg,
  PAYMENT_ID,
  PAYMENT_TIME,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
  WRONG_CHARGE_RESOURCES,
  WRONG_REFUND_RESOURCES,
} from "./fixtures.ts";

const saveCharges = (charges: readonly ChargeLeg[], observedAt: number) =>
  savePaymentCharges(PAYMENT_ID, SESSION_RESOURCE, charges, observedAt);

describeWithEnv("db > payments > charges", { db: true }, () => {
  test("stores refundable charge facts and reads them by payment", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);

    expect(await getPaymentCharges(PAYMENT_ID)).toEqual([
      {
        captured: { amount: 1_000, currency: "GBP" },
        createdAt: PAYMENT_TIME,
        id: 1,
        observedAt: PAYMENT_TIME,
        paymentId: PAYMENT_ID,
        pendingRefund: null,
        pendingRefundIdempotencyKey: null,
        providerReference: CHARGE_RESOURCE,
        refunded: { amount: 0, currency: "GBP" },
        refundState: "none",
        updatedAt: PAYMENT_TIME,
      },
    ]);
  });

  test("rejects resources outside the session hierarchy before storing", async () => {
    await Promise.all(
      WRONG_CHARGE_RESOURCES.map((resource) =>
        expect(
          savePaymentCharges(
            PAYMENT_ID,
            SESSION_RESOURCE,
            [{ ...chargeLeg(), resource }],
            PAYMENT_TIME,
          ),
        ).rejects.toThrow("Stored charge must belong to its payment session"),
      ),
    );
    await Promise.all(
      WRONG_REFUND_RESOURCES.map((refund) =>
        expect(
          savePaymentCharges(
            PAYMENT_ID,
            SESSION_RESOURCE,
            [chargeLeg(0, [pendingRefundObservation(refund)])],
            PAYMENT_TIME,
          ),
        ).rejects.toThrow("Stored refund must belong to its charge"),
      ),
    );
    expect(
      (await getDb().execute("SELECT id FROM payment_charges")).rows,
    ).toEqual([]);
  });

  test("rejects a refund outside its charge before storing it", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    const request = await requestChargeRefund(
      1,
      "refund-request-one",
      PAYMENT_TIME,
    );

    await Promise.all(
      WRONG_REFUND_RESOURCES.map((refund) =>
        expect(
          applyChargeRefund(
            1,
            request.idempotencyKey,
            { amount: 0, currency: "GBP" },
            pendingRefundObservation(refund),
            PAYMENT_TIME + 1,
          ),
        ).rejects.toThrow("Stored refund must belong to its charge"),
      ),
    );
    const stored = await getDb().execute(`SELECT refund_state,
      pending_refund_id FROM payment_charges WHERE id = 1`);
    expect(stored.rows).toEqual([
      { pending_refund_id: null, refund_state: "requested" },
    ]);
  });

  test("rejects refund requests for quarantined legacy charges", async () => {
    await insertLegacyPaymentCharge();

    await expect(
      requestChargeRefund(1, "legacy-refund-request", PAYMENT_TIME),
    ).rejects.toThrow("cannot be refunded from its current state");
  });

  test("encrypts provider references and matches them through a blind index", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    const result = await getDb().execute(
      "SELECT provider_reference, reference_index FROM payment_charges",
    );

    expect(String(result.rows[0]?.provider_reference)).toMatch(/^enc:1:/);
    expect(JSON.stringify(result.rows[0])).not.toContain(CHARGE_RESOURCE.id);

    // Seeing the same charge again updates the row it already has, which only
    // works because the blind index recognises the encrypted reference.
    await saveCharges([chargeLeg(500)], PAYMENT_TIME + 1);
    const stored = await getPaymentCharges(PAYMENT_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      refunded: { amount: 500, currency: "GBP" },
    });
  });

  test("keeps one stable refund idempotency key across retries", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);

    const first = await requestChargeRefund(
      1,
      "refund-request-one",
      PAYMENT_TIME,
    );
    const second = await requestChargeRefund(
      1,
      "different-proposal",
      PAYMENT_TIME + 1,
    );

    expect(first).toEqual({
      chargeId: 1,
      idempotencyKey: "refund-request-one",
    });
    expect(second).toEqual(first);
    const result = await getDb().execute(
      "SELECT pending_refund_idempotency_key, pending_refund_key_index FROM payment_charges",
    );
    expect(String(result.rows[0]?.pending_refund_idempotency_key)).toMatch(
      /^enc:1:/,
    );
    expect(JSON.stringify(result.rows[0])).not.toContain("refund-request-one");
  });

  test("retains a pending refund id and completes from cumulative money", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    const request = await requestChargeRefund(
      1,
      "refund-request-one",
      PAYMENT_TIME,
    );

    const pending = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      pendingRefundObservation(REFUND_RESOURCE),
      PAYMENT_TIME + 1,
    );
    expect(pending.refundState).toBe("pending");
    expect(pending.pendingRefund).toEqual(REFUND_RESOURCE);
    expect(pending.pendingRefundIdempotencyKey).toBe("refund-request-one");

    const completed = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 1_000, currency: "GBP" },
      {
        amount: { amount: 1_000, currency: "GBP" },
        refund: REFUND_RESOURCE,
        status: "completed",
      },
      PAYMENT_TIME + 2,
    );
    expect(completed.refundState).toBe("completed");
    expect(completed.refunded.amount).toBe(1_000);
    expect(completed.pendingRefund).toBeNull();
    expect(completed.pendingRefundIdempotencyKey).toBeNull();
  });

  test("retains a pending request when the provider has no refund resource", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    const request = await requestChargeRefund(
      1,
      "resource-less-request",
      PAYMENT_TIME,
    );

    const pending = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      { amount: { amount: 1_000, currency: "GBP" }, status: "pending" },
      PAYMENT_TIME + 1,
    );

    expect(pending.refundState).toBe("pending");
    expect(pending.pendingRefund).toBeNull();
    expect(pending.pendingRefundIdempotencyKey).toBe("resource-less-request");
    expect(
      await requestChargeRefund(1, "second-request", PAYMENT_TIME + 2),
    ).toEqual(request);
  });

  test("rejects a stale refund request key", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    await requestChargeRefund(1, "refund-request-one", PAYMENT_TIME);

    await expect(
      applyChargeRefund(
        1,
        "wrong-key",
        { amount: 1_000, currency: "GBP" },
        { amount: { amount: 1_000, currency: "GBP" }, status: "completed" },
        PAYMENT_TIME + 1,
      ),
    ).rejects.toThrow("Lost refund request for charge 1");
  });

  test("rejects refund results whose money disagrees", async () => {
    await saveCharges([chargeLeg()], PAYMENT_TIME);
    await requestChargeRefund(1, "refund-request-one", PAYMENT_TIME);

    await expect(
      applyChargeRefund(
        1,
        "refund-request-one",
        { amount: 1_000, currency: "GBP" },
        { amount: { amount: 1_000, currency: "USD" }, status: "completed" },
        PAYMENT_TIME + 1,
      ),
    ).rejects.toThrow("currency does not match");
    await expect(
      applyChargeRefund(
        1,
        "refund-request-one",
        { amount: 500, currency: "GBP" },
        { amount: { amount: 400, currency: "GBP" }, status: "partial" },
        PAYMENT_TIME + 1,
      ),
    ).rejects.toThrow("amount does not match");
  });

  test("rejects refund requests for missing and completed charges", async () => {
    await expect(
      requestChargeRefund(0, "request-zero", PAYMENT_TIME),
    ).rejects.toBeInstanceOf(v.ValiError);
    await expect(
      requestChargeRefund(99, "request-missing", PAYMENT_TIME),
    ).rejects.toThrow("Payment charge 99 was not found");
    await expect(
      applyChargeRefund(
        99,
        "request-missing",
        { amount: 0, currency: "GBP" },
        pendingRefundObservation(REFUND_RESOURCE),
        PAYMENT_TIME,
      ),
    ).rejects.toThrow("Stored refund must belong to its charge");
    await saveCharges(
      [
        chargeLeg(1_000, [
          {
            amount: { amount: 1_000, currency: "GBP" },
            refund: REFUND_RESOURCE,
            status: "completed",
          },
        ]),
      ],
      PAYMENT_TIME,
    );

    await expect(
      requestChargeRefund(1, "request-complete", PAYMENT_TIME),
    ).rejects.toThrow("cannot be refunded from its current state");
  });

  test("stores each explicit provider refund state", async () => {
    await saveCharges([], PAYMENT_TIME);
    await saveCharges(
      [
        chargeLeg(400, [
          {
            amount: { amount: 400, currency: "GBP" },
            refund: REFUND_RESOURCE,
            status: "completed",
          },
        ]),
      ],
      PAYMENT_TIME,
    );
    expect((await getPaymentCharges(PAYMENT_ID))[0]?.refundState).toBe(
      "partial",
    );

    await saveCharges(
      [chargeLeg(0, [pendingRefundObservation(REFUND_RESOURCE)])],
      PAYMENT_TIME + 1,
    );
    const pending = (await getPaymentCharges(PAYMENT_ID))[0];
    if (pending === undefined || !("pendingRefund" in pending)) {
      throw new Error("Expected a current payment charge");
    }
    expect(pending?.refundState).toBe("pending");
    expect(pending?.pendingRefund).toEqual(REFUND_RESOURCE);
    expect(pending?.pendingRefundIdempotencyKey).toBeNull();

    await saveCharges(
      [
        chargeLeg(0, [
          {
            amount: { amount: 0, currency: "GBP" },
            reason: "provider_failed",
            refund: REFUND_RESOURCE,
            status: "failed",
          },
        ]),
      ],
      PAYMENT_TIME + 2,
    );
    expect((await getPaymentCharges(PAYMENT_ID))[0]?.refundState).toBe(
      "failed",
    );
  });

  test("accepts the zero timestamp boundary on every charge write", async () => {
    await saveCharges([chargeLeg()], 0);
    const request = await requestChargeRefund(1, "zero-time-request", 0);
    const failed = await applyChargeRefund(
      1,
      request.idempotencyKey,
      { amount: 0, currency: "GBP" },
      {
        amount: { amount: 0, currency: "GBP" },
        reason: "provider_failed",
        status: "failed",
      },
      0,
    );

    expect(failed.createdAt).toBe(0);
    expect(failed.observedAt).toBe(0);
    expect(failed.updatedAt).toBe(0);
  });
});
