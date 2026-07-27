import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { savePaymentCharges } from "#shared/db/payments/charges.ts";
import {
  applyPaymentSessionClaim,
  claimPaymentSession,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import { submitPaymentDecision } from "#shared/payment-runtime/operator.ts";
import {
  PAYMENT_ID,
  PAYMENT_TIME,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  completePayment,
  createPendingPayment,
  paymentProviderRead,
} from "./fixtures.ts";

const provenBookingCase = async () => {
  const payment = await createPendingPayment();
  const read = paymentProviderRead({
    accountId: payment.accountId,
    bookingIntent: payment.bookingIntent,
    expected: payment.expected,
    mode: payment.mode,
  });
  if (read.status !== "found" || read.observation.charges === undefined) {
    throw new Error("Expected found payment evidence");
  }
  await savePaymentCharges(
    PAYMENT_ID,
    SESSION_RESOURCE,
    read.observation.charges,
    PAYMENT_TIME,
  );
  const claim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  await applyPaymentSessionClaim(claim, {
    attendeeId: null,
    completion: null,
    completionState: "none",
    nextReconcileAt: null,
    result: null,
    resultState: "none",
    session: SESSION_RESOURCE,
    state: "needs_action",
    ticketState: "none",
    ticketTokens: null,
  });
  const paymentCase = (
    await recordPaymentCase(
      {
        evidence: { kind: "provider_read", read },
        nextReconcileAt: null,
        paymentId: PAYMENT_ID,
        reason: "multiple_charges",
        resource: SESSION_RESOURCE,
        state: "needs_action",
      },
      PAYMENT_TIME,
    )
  ).paymentCase;
  return { payment, paymentCase };
};

const decisionInput = (
  paymentCase: Awaited<ReturnType<typeof provenBookingCase>>["paymentCase"],
) => ({
  actorId: 1,
  caseId: paymentCase.id,
  caseRevision: paymentCase.revision,
  reason: "The captured total proves the booking",
  selection: { kind: "complete_booking" as const },
});

describeWithEnv("payment operator booking completion", { db: true }, () => {
  test("uses the shared fulfilment callback for proven stored evidence", async () => {
    const { paymentCase } = await provenBookingCase();
    let fulfilledPaymentId = "";
    let fulfilCount = 0;
    const fulfil: typeof completePayment = (work) => {
      fulfilCount++;
      fulfilledPaymentId = work.payment.id;
      return completePayment(work);
    };

    const outcome = await submitPaymentDecision(
      {
        ...decisionInput(paymentCase),
      },
      fulfil,
    );

    expect(outcome.status).toBe("completed");
    expect(fulfilCount).toBe(1);
    expect(fulfilledPaymentId).toBe(PAYMENT_ID);
  });

  test("keeps the saved decision retryable while payment work is busy", async () => {
    const { paymentCase } = await provenBookingCase();
    const paymentClaim = await claimPaymentSession(PAYMENT_ID, 60_000);
    if (paymentClaim === null) throw new Error("Expected a payment claim");

    const outcome = await submitPaymentDecision(
      decisionInput(paymentCase),
      completePayment,
    );

    expect(outcome).toMatchObject({ status: "retrying" });
  });
});
