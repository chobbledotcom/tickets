import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { getPaymentCharges } from "#shared/db/payments/charges.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  resumePaymentDecision,
  submitPaymentDecision,
} from "#shared/payment-runtime/operator.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { REFUND_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createRefundablePaymentCase } from "./fixtures.ts";

const unusedFulfil = (): never => {
  throw new Error("Refund decisions must not fulfil a booking");
};

const submit = (
  caseId: number,
  caseRevision: number,
  kind: "confirm_fully_refunded" | "refund_remaining",
) =>
  submitPaymentDecision(
    {
      actorId: 1,
      caseId,
      caseRevision,
      reason: "Checked the full payment record",
      selection: { kind },
    },
    unusedFulfil,
  );

describeWithEnv("payment operator refunds", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("persists the decision before refunding every charge", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    let stateBeforeProvider = "";
    using provider = stub(
      stripePaymentProvider,
      "refundCharge",
      async (charge) => {
        const row = await getDb().execute(
          "SELECT state, claim, decision FROM payment_case_decisions",
        );
        stateBeforeProvider = String(row.rows[0]?.state);
        expect(String(row.rows[0]?.claim)).toMatch(/^enc:1:/);
        expect(String(row.rows[0]?.decision)).toMatch(/^enc:1:/);
        return {
          amount: charge.captured,
          refund: {
            ...REFUND_RESOURCE,
            id: `refund-${charge.id}`,
            parentId: charge.providerReference.id,
          },
          status: "completed" as const,
        };
      },
    );

    const outcome = await submit(
      paymentCase.id,
      paymentCase.revision,
      "refund_remaining",
    );

    expect(outcome.status).toBe("completed");
    expect(stateBeforeProvider).toBe("running");
    expect(provider.calls).toHaveLength(2);
    expect(await getPaymentCharges(paymentCase.paymentId)).toMatchObject([
      { refunded: { amount: 1_000 } },
      { refunded: { amount: 1_000 } },
    ]);
  });

  test("keeps a pending refund due and retryable", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    const provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        refund: {
          ...REFUND_RESOURCE,
          id: `pending-${charge.id}`,
          parentId: charge.providerReference.id,
        },
        status: "pending" as const,
      }),
    );

    const outcome = await submit(
      paymentCase.id,
      paymentCase.revision,
      "refund_remaining",
    );
    const [decision] = await getPaymentCaseDecisions(paymentCase.id);

    expect(outcome.status).toBe("retrying");
    expect(decision).toMatchObject({ attemptCount: 1, state: "retrying" });
    expect(decision?.nextRetryAt).not.toBeNull();

    provider.restore();
    using _completedProvider = stub(
      stripePaymentProvider,
      "refundCharge",
      (charge) =>
        Promise.resolve({
          amount: charge.captured,
          refund: charge.pendingRefund ?? undefined,
          status: "completed" as const,
        }),
    );
    if (decision === undefined) {
      throw new Error("Expected a retryable payment decision");
    }
    await getDb().execute(
      "UPDATE payment_case_decisions SET next_retry_at = created_at WHERE id = ?",
      [decision.id],
    );
    const resumed = await resumePaymentDecision(decision.id, unusedFulfil);

    expect(resumed.status).toBe("completed");
    await expect(
      resumePaymentDecision(decision.id, unusedFulfil),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(resumePaymentDecision(999_999, unusedFulfil)).rejects.toThrow(
      "was not found",
    );
  });

  test("records authoritative full refunds before shared completion", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    using provider = stub(stripePaymentProvider, "refundCharge", () => {
      throw new Error("Confirmed refunds must not call the provider");
    });

    const outcome = await submit(
      paymentCase.id,
      paymentCase.revision,
      "confirm_fully_refunded",
    );
    const [decision] = await getPaymentCaseDecisions(paymentCase.id);

    expect(outcome.status).toBe("completed");
    expect(provider.calls).toHaveLength(0);
    expect(decision?.decision).toMatchObject({
      charges: [
        { captured: { amount: 1_000 }, chargeId: 1 },
        { captured: { amount: 1_000 }, chargeId: 2 },
      ],
      kind: "confirm_fully_refunded",
    });
    expect(await getPaymentCharges(paymentCase.paymentId)).toMatchObject([
      { refunded: { amount: 1_000 }, refundState: "completed" },
      { refunded: { amount: 1_000 }, refundState: "completed" },
    ]);
  });

  test("allows only one concurrent submission to reach the provider", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    using provider = stub(stripePaymentProvider, "refundCharge", (charge) =>
      Promise.resolve({
        amount: charge.captured,
        status: "completed" as const,
      }),
    );

    const outcomes = await Promise.allSettled([
      submit(paymentCase.id, paymentCase.revision, "refund_remaining"),
      submit(paymentCase.id, paymentCase.revision, "refund_remaining"),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);
  });

  test("keeps a failed provider action retryable and reports its cause", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    using _provider = stub(stripePaymentProvider, "refundCharge", () => {
      throw new Error("Provider transport failed");
    });

    await expect(
      submit(paymentCase.id, paymentCase.revision, "refund_remaining"),
    ).rejects.toThrow("failed: Provider transport failed");
    expect(await getPaymentCaseDecisions(paymentCase.id)).toMatchObject([
      { state: "retrying" },
    ]);
  });

  test("fails loudly if a payment case vanishes during confirmation", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    await getDb().execute(`CREATE TRIGGER delete_confirmed_payment_case
      AFTER UPDATE OF refunded_amount ON payment_charges
      BEGIN
        DELETE FROM payment_cases WHERE id = ${paymentCase.id};
      END`);

    await expect(
      submit(paymentCase.id, paymentCase.revision, "confirm_fully_refunded"),
    ).rejects.toThrow(
      `Payment case ${paymentCase.id} changed before completion`,
    );
    expect(await getPaymentCaseDecisions(paymentCase.id)).toMatchObject([
      { state: "retrying" },
    ]);
  });
});
