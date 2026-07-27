import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PaymentCaseDecision } from "#shared/db/payments/types.ts";
import { preparePaymentDecision } from "#shared/payment-runtime/operator-claim.ts";
import {
  legacyPaymentDecision,
  legacyPaymentOperatorCase,
  paymentCharge,
} from "#test/shared/payment-runtime/fixtures.ts";

const PAYMENT_TIME = 1_785_024_000_000;

/** A decision where the owner looked the old payment up at the provider and
 *  wrote down what they found. */
const reviewedLegacyDecision = (caseId: number): PaymentCaseDecision =>
  legacyPaymentDecision({
    decision: {
      accountId: "acct_1",
      actorId: 1,
      caseRevision: 1,
      decidedAt: PAYMENT_TIME,
      kind: "assign_provider",
      mode: "live",
      provider: "stripe",
      read: {
        captured: { amount: 1_000, currency: "GBP" },
        refunded: { amount: 0, currency: "GBP" },
        status: "reviewed",
      },
      reason: "Looked it up at the provider",
    },
    paymentCaseId: caseId,
    selection: {
      accountId: "acct_1",
      kind: "assign_provider",
      mode: "live",
      provider: "stripe",
    },
  });

/** Keeping an old payment as it is, decided by the owner. */
const keepLegacyPayment = (
  context: ReturnType<typeof legacyPaymentOperatorCase>,
) =>
  preparePaymentDecision(
    context,
    1,
    context.case.revision,
    "  Checked the old payment  ",
    { kind: "keep_legacy_payment" },
    PAYMENT_TIME,
  );

describe("preparing the owner's decision about an old payment", () => {
  test("writes down the reference the decision was made against", () => {
    // The owner already looked the old payment up at the provider and said
    // what they found, which is what puts "keep this as it is" in front of
    // them as a choice.
    const context = legacyPaymentOperatorCase();
    context.decisions = [reviewedLegacyDecision(context.case.id)];

    const { claim, decision } = keepLegacyPayment(context);

    expect(claim.reviewed).toEqual({
      charges: [{ chargeId: 1, providerReference: "hyb:1:legacy-reference" }],
      kind: "legacy_assignment",
      paymentId: claim.reviewed.paymentId,
    });
    expect(decision).toMatchObject({
      actorId: 1,
      decidedAt: PAYMENT_TIME,
      kind: "keep_legacy_payment",
      reason: "Checked the old payment",
    });
  });

  test("refuses when the old payment has no reference left to keep", () => {
    // Every charge came across as a current one, so there is no old record for
    // "keep this as it is" to point at.
    const context = legacyPaymentOperatorCase();
    context.charges = [
      paymentCharge({ pendingRefundIdempotencyKey: null, refundState: "none" }),
    ];

    expect(() => keepLegacyPayment(context)).toThrow("has no reference");
  });
});
