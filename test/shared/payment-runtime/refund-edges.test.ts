import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { claimPaymentSession } from "#shared/db/payments/claims.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type { LegacyPaymentCharge } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import {
  currentPaymentCharges,
  refundCharges,
  refundChargesKeepingClaim,
} from "#shared/payment-runtime/refund.ts";
import { refundReferences } from "#shared/payment-runtime/refund-targets.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  PAYMENT_ID,
  PAYMENT_TIME,
  REFUND_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { required } from "#test-utils/required.ts";
import {
  createFullyRefundedPayment,
  createRefundablePayment,
} from "./fixtures.ts";

const storedPayment = async (): Promise<
  NonNullable<Awaited<ReturnType<typeof getPaymentSessions>>[number]>
> => {
  const [payment] = await getPaymentSessions([PAYMENT_ID]);
  if (payment === null || payment === undefined) {
    throw new Error("Expected stored payment");
  }
  return payment;
};

describeWithEnv("payment refund engine edges", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("rejects a legacy charge before provider IO", async () => {
    const { payment } = await createRefundablePayment();
    const legacy: LegacyPaymentCharge = {
      createdAt: PAYMENT_TIME,
      id: 99,
      observedAt: PAYMENT_TIME,
      paymentId: PAYMENT_ID,
      providerReference: "hyb:1:key:iv:legacy-reference",
      providerRefundedAt: null,
      refundState: "unknown",
      source: "processed_payments",
      updatedAt: PAYMENT_TIME,
    };

    expect(() => currentPaymentCharges(payment, [legacy])).toThrow(
      `Payment ${PAYMENT_ID} contains a legacy charge`,
    );
  });

  test("builds ordered references with each leg's completed state", async () => {
    const { charges, payment } = await createRefundablePayment(2);
    const [first, second] = charges;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two payment charges");
    }
    const completed = {
      ...first,
      refunded: first.captured,
      refundState: "completed" as const,
    };

    expect(
      refundReferences([{ charges: [completed, second], payment }]),
    ).toEqual([
      {
        providerRefunded: true,
        reference: completed.providerReference.id,
        sessionIds: [PAYMENT_ID],
      },
      {
        providerRefunded: false,
        reference: second.providerReference.id,
        sessionIds: [PAYMENT_ID],
      },
    ]);
  });

  test("records a failed outcome when the stored provider account changed", async () => {
    const { charges } = await createRefundablePayment();
    await getDb().execute(
      "UPDATE payment_sessions SET account_id = 'different-account' WHERE id = ?",
      [PAYMENT_ID],
    );
    using provider = stub(stripePaymentProvider, "refundCharge", () =>
      Promise.reject(new Error("Account mismatch must stop before Stripe")),
    );

    const outcome = await refundCharges(await storedPayment(), charges);

    expect(outcome.status).toBe("failed");
    expect(outcome.payment.state).toBe("refunding");
    expect(provider.calls).toHaveLength(0);
    const cases = await getDb().execute(
      "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
      [PAYMENT_ID],
    );
    expect(cases.rows).toEqual([
      { reason: "failed_refund", state: "retrying" },
    ]);
  });

  test("keeps the claim when the money was already all sent back", async () => {
    // Finishing a placeholder booking asks for the refund while holding the
    // claim. If the provider already returned everything there is nothing to
    // ask it for, and the claim must stay held so the rest can finish.
    const { charge, payment } = await createFullyRefundedPayment();
    const settled = await refundCharges(payment, [charge]);
    const claim = required(
      await claimPaymentSession(PAYMENT_ID, 60_000),
      "the payment claim",
    );
    using provider = stub(stripePaymentProvider, "refundCharge", () =>
      Promise.reject(new Error("A refunded charge must not reach Stripe")),
    );

    const attempt = await refundChargesKeepingClaim(settled.payment, claim);

    expect(attempt).toMatchObject({ claim, ok: true, status: "completed" });
    expect(provider.calls).toHaveLength(0);
  });

  test("uses a caller's existing claim for the refund", async () => {
    const { charges, payment } = await createRefundablePayment();
    const claim = await claimPaymentSession(PAYMENT_ID, 60_000);
    if (claim === null) throw new Error("Expected payment claim");
    using _provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          parentId: charge.providerReference.id,
        },
        status: "completed" as const,
      }),
    );

    expect((await refundCharges(payment, charges, claim)).status).toBe(
      "completed",
    );
  });

  test("fails when another worker holds the payment claim", async () => {
    const { charges, payment } = await createRefundablePayment();
    const held = await claimPaymentSession(PAYMENT_ID, 60_000);
    if (held === null) throw new Error("Expected held payment claim");

    await expect(refundCharges(payment, charges)).rejects.toThrow(
      `Could not claim payment session ${PAYMENT_ID} for refund`,
    );
  });

  test("fails before claiming a payment with no charges", async () => {
    const { payment } = await createRefundablePayment();
    await getDb().execute("DELETE FROM payment_charges WHERE payment_id = ?", [
      PAYMENT_ID,
    ]);

    await expect(refundCharges(payment)).rejects.toThrow(
      `Payment ${PAYMENT_ID} has no refundable charges`,
    );
  });
});
