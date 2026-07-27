import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { getDb } from "#shared/db/client.ts";
import {
  applyChargeRefund,
  getPaymentCharges,
  requestChargeRefund,
  savePaymentCharges,
} from "#shared/db/payments/charges.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type { PaymentCharge } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { refundCharges } from "#shared/payment-runtime/refund.ts";
import type { RefundResolution } from "#shared/payment-state/resources.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  PAYMENT_ID,
  PAYMENT_TIME,
  REFUND_RESOURCE,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createRefundablePayment } from "./fixtures.ts";
import { retryRefundUntilStopped } from "./refund-retries.ts";

const laterRefundResolution = (
  charge: PaymentCharge,
  secondChargeId: number | undefined,
  succeeds: boolean,
): RefundResolution => {
  const refund =
    charge.id === secondChargeId
      ? {
          ...REFUND_RESOURCE,
          id: `refund-${charge.id}`,
          parentId: charge.providerReference.id,
        }
      : undefined;
  return succeeds
    ? {
        amount: charge.captured,
        ...(refund === undefined ? {} : { refund }),
        status: "completed",
      }
    : {
        amount: charge.refunded,
        reason: "provider_failed",
        ...(refund === undefined ? {} : { refund }),
        status: "failed",
      };
};

describeWithEnv("payment refund engine", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("keeps a pending refund id and request key across checks", async () => {
    const { charges, payment } = await createRefundablePayment();
    const keys: string[] = [];
    using provider = stub(
      stripePaymentProvider,
      "refundCharge",
      (charge, key) => {
        keys.push(key);
        return Promise.resolve(
          charge.pendingRefund === null
            ? {
                amount: charge.captured,
                refund: {
                  ...REFUND_RESOURCE,
                  parentId: charge.providerReference.id,
                },
                status: "pending" as const,
              }
            : {
                amount: charge.captured,
                refund: charge.pendingRefund,
                status: "completed" as const,
              },
        );
      },
    );

    const pending = await refundCharges(payment, charges);
    const [storedPending] = await getPaymentCharges(PAYMENT_ID);
    if (storedPending === undefined || !("captured" in storedPending)) {
      throw new Error("Expected pending charge");
    }
    expect(pending.status).toBe("pending");
    expect(storedPending).toMatchObject({
      pendingRefund: { id: REFUND_RESOURCE.id },
      refundState: "pending",
    });

    const completed = await refundCharges(pending.payment, [storedPending]);
    expect(completed.status).toBe("completed");
    expect(keys).toEqual([keys[0], keys[0]]);
    expect(provider.calls[1]?.args[0].pendingRefund?.id).toBe(
      REFUND_RESOURCE.id,
    );
  });

  test("keeps a provider error reclaimable without losing its request key", async () => {
    const { charges, payment } = await createRefundablePayment();
    using _provider = stub(stripePaymentProvider, "refundCharge", () =>
      Promise.reject(new Error("Provider unavailable")),
    );

    await expect(refundCharges(payment, charges)).rejects.toThrow(
      "Provider unavailable",
    );

    const [storedPayment] = await getPaymentSessions([PAYMENT_ID]);
    const [storedCharge] = await getPaymentCharges(PAYMENT_ID);
    if (storedCharge === undefined || !("captured" in storedCharge)) {
      throw new Error("Expected requested refund charge");
    }
    expect(storedPayment?.state).toBe("refunding");
    expect(storedCharge).toMatchObject({
      refundState: "requested",
    });
    expect(storedCharge.pendingRefundIdempotencyKey).not.toBeNull();
  });

  test("marks fully refunded only after every charge is confirmed", async () => {
    const { charges, payment } = await createRefundablePayment(2);
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          id: `refund-${charge.id}`,
          parentId: charge.providerReference.id,
        },
        status: "completed" as const,
      }),
    );

    const outcome = await refundCharges(payment, charges);

    expect(outcome.status).toBe("completed");
    expect(outcome.resolutions).toHaveLength(2);
    expect(outcome.payment.state).toBe("fully_refunded");
    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      { refunded: { amount: 1_000 } },
      { refunded: { amount: 1_000 } },
    ]);
  });

  test("retries only unfinished legs after a later charge throws", async () => {
    const { charges, payment } = await createRefundablePayment(2);
    const attempts: { chargeId: number; key: string }[] = [];
    let secondAttempts = 0;
    using _provider = stub(
      stripePaymentProvider,
      "refundCharge",
      (charge, key) => {
        attempts.push({ chargeId: charge.id, key });
        if (charge.id === charges[1]?.id && secondAttempts++ === 0) {
          return Promise.reject(new Error("Second refund unavailable"));
        }
        return Promise.resolve({
          amount: charge.captured,
          refund: {
            ...REFUND_RESOURCE,
            id: `refund-${charge.id}`,
            parentId: charge.providerReference.id,
          },
          status: "completed" as const,
        });
      },
    );

    await expect(refundCharges(payment, charges)).rejects.toThrow(
      "Second refund unavailable",
    );
    const [storedPayment] = await getPaymentSessions([PAYMENT_ID]);
    if (storedPayment === null || storedPayment === undefined) {
      throw new Error("Expected refunding payment");
    }
    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      { refunded: { amount: 1_000 }, refundState: "completed" },
      { refunded: { amount: 0 }, refundState: "requested" },
    ]);
    const retried = await refundCharges(storedPayment);

    expect(retried.status).toBe("completed");
    expect(retried.resolutions).toMatchObject([
      { amount: { amount: 1_000 }, status: "completed" },
      { amount: { amount: 1_000 }, status: "completed" },
    ]);
    expect(attempts.map(({ chargeId }) => chargeId)).toEqual([
      charges[0]?.id,
      charges[1]?.id,
      charges[1]?.id,
    ]);
    expect(attempts[2]?.key).toBe(attempts[1]?.key);
  });

  test("treats every fully refunded charge as a successful provider no-op", async () => {
    const { charges, payment } = await createRefundablePayment();
    const charge = charges[0];
    if (charge === undefined) throw new Error("Expected refundable charge");
    const request = await requestChargeRefund(
      charge.id,
      "completed-refund-request",
      PAYMENT_TIME,
    );
    const completedCharge = await applyChargeRefund(
      charge.id,
      request.idempotencyKey,
      charge.captured,
      { amount: charge.captured, status: "completed" },
      PAYMENT_TIME + 1,
    );
    using provider = stub(stripePaymentProvider, "refundCharge", () =>
      Promise.reject(new Error("A completed charge must not reach Stripe")),
    );

    const completed = await refundCharges(payment, [completedCharge]);
    const replayed = await refundCharges(completed.payment, [completedCharge]);

    expect(completed.payment.state).toBe("fully_refunded");
    expect(replayed).toMatchObject({
      payment: { state: "fully_refunded" },
      resolutions: [
        { amount: { amount: 1_000, currency: "GBP" }, status: "completed" },
      ],
      status: "completed",
    });
    expect(provider.calls).toHaveLength(0);
  });

  test("keeps cumulative partial money exact for every charge currency", async () => {
    const { charges, payment } = await createRefundablePayment(2);
    const partialMoney = [
      { amount: 400, currency: "GBP" },
      { amount: 725, currency: "EUR" },
    ] as const;
    await savePaymentCharges(
      PAYMENT_ID,
      SESSION_RESOURCE,
      charges.map((charge, index) => {
        const money = partialMoney[index];
        if (money === undefined)
          throw new Error("Expected partial refund money");
        return {
          captured: {
            amount: index === 0 ? 1_000 : 2_300,
            currency: money.currency,
          },
          confirmedRefunded: money,
          refunds: [
            {
              amount: money,
              refund: {
                ...REFUND_RESOURCE,
                id: `partial-${charge.id}`,
                parentId: charge.providerReference.id,
              },
              status: "completed" as const,
            },
          ],
          resource: charge.providerReference,
        };
      }),
      PAYMENT_TIME + 1,
    );
    const partialCharges = (await getPaymentCharges(PAYMENT_ID)).map(
      (charge) => {
        if (!("captured" in charge)) throw new Error("Expected current charge");
        return charge;
      },
    );
    const seen: { amount: number; currency: string }[] = [];
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) => {
      seen.push(charge.refunded);
      return Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          id: `remaining-${charge.id}`,
          parentId: charge.providerReference.id,
        },
        status: "completed" as const,
      });
    });

    const outcome = await refundCharges(payment, partialCharges);

    expect(seen).toEqual(partialMoney);
    expect(outcome.resolutions.map(({ amount }) => amount)).toEqual([
      { amount: 1_000, currency: "GBP" },
      { amount: 2_300, currency: "EUR" },
    ]);
    expect(await getPaymentCharges(PAYMENT_ID)).toMatchObject([
      { refunded: { amount: 1_000, currency: "GBP" } },
      { refunded: { amount: 2_300, currency: "EUR" } },
    ]);
  });

  test("stores a partial refund as a permanent case", async () => {
    const { charges, payment } = await createRefundablePayment();
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: { amount: 400, currency: "GBP" },
        refund: { ...REFUND_RESOURCE, parentId: charge.providerReference.id },
        status: "partial" as const,
      }),
    );

    const outcome = await refundCharges(payment, charges);

    expect(outcome.status).toBe("partial");
    expect(outcome.payment.state).toBe("needs_action");
    const cases = await getDb().execute(
      "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
      [PAYMENT_ID],
    );
    expect(cases.rows).toEqual([
      { reason: "partial_refund", state: "needs_action" },
    ]);
  });

  test("stops failed refund polling and closes exact cases after success", async () => {
    using time = new FakeTime(PAYMENT_TIME);
    const { charges, payment } = await createRefundablePayment(2);
    let succeeds = false;
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve(laterRefundResolution(charge, charges[1]?.id, succeeds)),
    );

    const current = await retryRefundUntilStopped(time, payment);

    expect(current.state).toBe("needs_action");
    expect(current.nextReconcileAt).toBeNull();
    expect(
      (
        await getDb().execute(
          "SELECT reason, state FROM payment_cases WHERE payment_id = ? ORDER BY id",
          [PAYMENT_ID],
        )
      ).rows,
    ).toEqual([
      { reason: "failed_refund", state: "needs_action" },
      { reason: "failed_refund", state: "needs_action" },
    ]);

    succeeds = true;
    const completed = await refundCharges(current);

    expect(completed.payment.state).toBe("fully_refunded");
    expect(
      (
        await getDb().execute(
          "SELECT state FROM payment_cases WHERE payment_id = ? ORDER BY id",
          [PAYMENT_ID],
        )
      ).rows,
    ).toEqual([{ state: "resolved" }, { state: "resolved" }]);
  });
});
