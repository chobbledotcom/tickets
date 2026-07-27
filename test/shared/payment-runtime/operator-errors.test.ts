import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { getPaymentCaseDecisions } from "#shared/db/payments/decisions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  resumePaymentDecision,
  submitPaymentDecision,
} from "#shared/payment-runtime/operator.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  createAcceptedRefundDecision,
  createRefundablePaymentCase,
  createRetryingPaymentDecision,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { savePaymentCharges } from "#test-utils/payment-aggregate.ts";

const unusedFulfil = (): never => {
  throw new Error("This decision must not fulfil a booking");
};

const noRefundCalls = () =>
  stub(stripePaymentProvider, "refundCharge", () => {
    throw new Error("A stale decision must not call the provider");
  });

const expectChangedPaymentNeedsReview = async (
  change: (
    target: Awaited<ReturnType<typeof createRefundablePaymentCase>>,
  ) => Promise<void>,
): Promise<void> => {
  const target = await createRefundablePaymentCase();
  const decision = await createRetryingPaymentDecision(
    target.paymentCase,
    { kind: "refund_remaining" },
    null,
  );
  await change(target);
  using provider = noRefundCalls();

  expect(await resumePaymentDecision(decision.id, unusedFulfil)).toMatchObject({
    status: "review_again",
  });
  expect(provider.calls).toHaveLength(0);
};

describeWithEnv("payment operator stale decisions", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("fails when the submitted payment case does not exist", async () => {
    await expect(
      submitPaymentDecision(
        {
          actorId: 1,
          caseId: 999_999,
          caseRevision: 1,
          reason: "Checked the payment",
          selection: { kind: "refund_remaining" },
        },
        unusedFulfil,
      ),
    ).rejects.toThrow("Payment case 999999 was not found");
  });

  test("rejects a choice that the current facts do not offer", async () => {
    const { paymentCase } = await createRefundablePaymentCase();
    await expect(
      submitPaymentDecision(
        {
          actorId: 1,
          caseId: paymentCase.id,
          caseRevision: paymentCase.revision,
          reason: "Checked the payment",
          selection: { kind: "complete_booking" },
        },
        unusedFulfil,
      ),
    ).rejects.toThrow("decision is not available");
    expect(await getPaymentCaseDecisions(paymentCase.id)).toEqual([]);
  });

  test("reviews again when the case revision changes after acceptance", async () => {
    const target = await createAcceptedRefundDecision();
    await recordPaymentCase({
      evidence: target.paymentCase.evidence,
      nextReconcileAt: null,
      paymentId: target.paymentCase.paymentId,
      reason: target.paymentCase.reason,
      resource: target.paymentCase.resource,
      state: "needs_action",
    });
    using provider = noRefundCalls();

    expect(
      await resumePaymentDecision(target.decision.id, unusedFulfil),
    ).toMatchObject({ status: "review_again" });
    expect(provider.calls).toHaveLength(0);
    expect(await getPaymentCaseDecisions(target.paymentCase.id)).toMatchObject([
      { state: "completed" },
    ]);
  });

  test("reviews again when a captured amount changes before retry", async () => {
    await expectChangedPaymentNeedsReview(async (target) => {
      await getDb().execute(
        "UPDATE payment_charges SET captured_amount = 1100 WHERE id = ?",
        [target.charges[0]!.id],
      );
    });
  });

  test("reviews again when a charge is added before retry", async () => {
    await expectChangedPaymentNeedsReview(async (target) => {
      if (target.payment.session === null)
        throw new Error("Expected a session");
      await savePaymentCharges(
        target.payment.id,
        target.payment.session,
        [
          {
            captured: { amount: 500, currency: "GBP" },
            confirmedRefunded: { amount: 0, currency: "GBP" },
            refunds: [],
            resource: {
              ...target.charges[0]!.providerReference,
              id: "pi_added_charge",
            },
          },
        ],
        Date.now(),
      );
    });
  });
});
