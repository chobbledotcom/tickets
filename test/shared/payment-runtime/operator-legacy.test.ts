import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import {
  getPaymentCaseByIdOrNull,
  recordPaymentCase,
} from "#shared/db/payments/cases.ts";
import type { PaymentCase } from "#shared/db/payments/types.ts";
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  resumePaymentDecision,
  submitPaymentDecision,
} from "#shared/payment-runtime/operator.ts";
import {
  getPaymentOperatorCase,
  paymentDecisionSelections,
} from "#shared/payment-runtime/operator-context.ts";
import { squareApi } from "#shared/square.ts";
import { PAYMENT_TIME } from "#test/shared/db/payments/fixtures.ts";
import {
  createLegacyAttendeePaymentCase,
  createRetryingPaymentDecision,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withTestSession } from "#test-utils/session.ts";

const unusedFulfil = (): never => {
  throw new Error("Legacy assignment must not fulfil a booking");
};

const configureSquare = (locationId = "location-one"): void =>
  settings.setForTest({
    square_access_token: "square-token",
    square_location_id: locationId,
    square_sandbox: true,
  });

const submitSquare = (caseId: number, caseRevision: number) =>
  withTestSession(async () => {
    const account = await resolvePaymentAccount("square");
    return submitPaymentDecision(
      {
        actorId: 1,
        caseId,
        caseRevision,
        reason: "This should use the Square account",
        selection: { ...account, kind: "assign_provider" },
      },
      unusedFulfil,
    );
  });

const savedProviderDecision = async (paymentCase: PaymentCase) => {
  const account = await resolvePaymentAccount("square");
  const reason = "Checked the stored payment facts";
  return createRetryingPaymentDecision(
    paymentCase,
    { ...account, kind: "assign_provider" },
    {
      accountId: account.accountId,
      actorId: 1,
      caseRevision: paymentCase.revision,
      decidedAt: PAYMENT_TIME,
      kind: "assign_provider",
      mode: account.mode,
      provider: "square",
      read: { status: "missing" },
      reason,
    },
  );
};

describeWithEnv("payment operator legacy assignment", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("keeps ambiguous typed provider facts open without inventing a session", async () => {
    configureSquare();
    const paymentCase =
      await createLegacyAttendeePaymentCase("square-payment-old");
    using read = stub(squareApi, "readPayment", () =>
      Promise.resolve({
        status: "found" as const,
        value: {
          amountMoney: { amount: BigInt(1_000), currency: "GBP" },
          createdAt: "2026-07-26T12:00:00.000Z",
          id: "square-payment-old",
          locationId: "location-one",
          status: "COMPLETED",
        },
      }),
    );

    const outcome = await submitSquare(paymentCase.id, paymentCase.revision);
    const current = await getPaymentOperatorCase(paymentCase.id);

    expect(outcome.status).toBe("needs_action");
    expect(read.calls).toHaveLength(1);
    expect(current?.case).toMatchObject({
      reason: "legacy_mapping_ambiguous",
      state: "needs_action",
    });
    expect(current?.case.revision).toBe(paymentCase.revision + 1);
    expect(current?.decisions[0]?.decision).toMatchObject({
      kind: "assign_provider",
      provider: "square",
      read: {
        captured: { amount: 1_000, currency: "GBP" },
        status: "reviewed",
      },
    });
    expect(current?.charges[0]).not.toHaveProperty("captured");
  });

  test("keeps a missing provider record open", async () => {
    configureSquare();
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-missing",
    );
    using _read = stub(squareApi, "readPayment", () =>
      Promise.resolve({ status: "missing" as const }),
    );

    const outcome = await submitSquare(paymentCase.id, paymentCase.revision);
    const current = await getPaymentOperatorCase(paymentCase.id);

    expect(outcome.status).toBe("needs_action");
    expect(current?.case.reason).toBe("legacy_provider_unknown");
    expect(current?.decisions[0]?.decision).toMatchObject({
      read: { status: "missing" },
    });
  });

  test("attaches an exact provider session and charge", async () => {
    configureSquare();
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-attached",
    );
    const refundCase = (
      await recordPaymentCase({
        evidence: paymentCase.evidence,
        nextReconcileAt: null,
        paymentId: paymentCase.paymentId,
        reason: "legacy_refund_amount_unknown",
        resource: {
          id: `${paymentCase.paymentId}:refund-sibling`,
          kind: "legacy_payment",
          source: "attendee_merge",
        },
        state: "needs_action",
      })
    ).paymentCase;
    const lifecycleCase = (
      await recordPaymentCase({
        evidence: paymentCase.evidence,
        nextReconcileAt: null,
        paymentId: paymentCase.paymentId,
        reason: "legacy_lifecycle_unknown",
        resource: {
          id: `${paymentCase.paymentId}:lifecycle-sibling`,
          kind: "legacy_payment",
          source: "attendee_merge",
        },
        state: "needs_action",
      })
    ).paymentCase;
    using _read = stub(squareApi, "readPayment", () =>
      Promise.resolve({
        status: "found" as const,
        value: {
          amountMoney: { amount: BigInt(1_000), currency: "GBP" },
          id: "square-payment-attached",
          locationId: "location-one",
          orderId: "square-order-attached",
          status: "COMPLETED",
        },
      }),
    );

    const outcome = await submitSquare(paymentCase.id, paymentCase.revision);
    const current = await getPaymentOperatorCase(paymentCase.id);

    expect(outcome.status).toBe("completed");
    expect(current).toMatchObject({
      case: { state: "resolved" },
      charges: [
        {
          captured: { amount: 1_000, currency: "GBP" },
          providerReference: {
            id: "square-payment-attached",
            parentId: "square-order-attached",
          },
        },
      ],
    });
    expect(await getPaymentCaseByIdOrNull(refundCase.id)).toMatchObject({
      state: "resolved",
    });
    const lifecycle = await getPaymentOperatorCase(lifecycleCase.id);
    if (lifecycle === null) throw new Error("Expected the lifecycle case");
    expect(lifecycle.case.state).toBe("needs_action");
    expect(paymentDecisionSelections(lifecycle, [])).toEqual([
      { kind: "keep_legacy_payment" },
    ]);
  });

  test("resumes from saved provider facts without reading twice", async () => {
    configureSquare();
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-saved",
    );
    const accepted = await savedProviderDecision(paymentCase);
    using provider = stub(squareApi, "readPayment", () => {
      throw new Error("Saved provider facts must be reused");
    });

    const outcome = await resumePaymentDecision(accepted.id, unusedFulfil);

    expect(outcome.status).toBe("needs_action");
    expect(provider.calls).toHaveLength(0);
  });

  test("resumes after an attached provider charge was saved", async () => {
    configureSquare();
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-upgraded",
    );
    await getDb().execute(`CREATE TRIGGER fail_legacy_case_finish
      BEFORE UPDATE ON payment_cases
      BEGIN
        SELECT RAISE(ABORT, 'finish failed');
      END`);
    using provider = stub(squareApi, "readPayment", () =>
      Promise.resolve({
        status: "found" as const,
        value: {
          amountMoney: { amount: BigInt(1_000), currency: "GBP" },
          id: "square-payment-upgraded",
          locationId: "location-one",
          orderId: "square-order-upgraded",
          status: "COMPLETED",
        },
      }),
    );

    await expect(
      submitSquare(paymentCase.id, paymentCase.revision),
    ).rejects.toThrow("finish failed");
    await getDb().execute("DROP TRIGGER fail_legacy_case_finish");
    const failed = await getPaymentOperatorCase(paymentCase.id);
    const decision = failed?.decisions[0];
    if (decision === undefined) throw new Error("Expected a saved decision");
    await getDb().execute(
      "UPDATE payment_case_decisions SET next_retry_at = created_at WHERE id = ?",
      [decision.id],
    );

    expect(
      await resumePaymentDecision(decision.id, unusedFulfil),
    ).toMatchObject({ status: "completed" });
    expect(provider.calls).toHaveLength(1);
  });

  test("rejects saved provider facts after the account changes", async () => {
    configureSquare();
    const paymentCase = await createLegacyAttendeePaymentCase(
      "square-payment-account-change",
    );
    const accepted = await savedProviderDecision(paymentCase);
    configureSquare("location-two");

    expect(
      await resumePaymentDecision(accepted.id, unusedFulfil),
    ).toMatchObject({ status: "review_again" });
  });
});
