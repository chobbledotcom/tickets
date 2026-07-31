import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { routePayment } from "#routes/api/webhooks.ts";
import { getDb } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  createPaymentSession,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import {
  PAYMENT_COMPLETED_BOOKING,
  PAYMENT_ID,
  paymentSessionInput,
  READY_RESULT,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const storeCompletedPayment = async (): Promise<void> => {
  await createPaymentSession(paymentSessionInput());
  const processingClaim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  await applyPaymentSessionClaim(processingClaim, {
    attendeeId: null,
    completion: null,
    completionState: "none",
    nextReconcileAt: null,
    result: READY_RESULT,
    resultState: "succeeded",
    session: SESSION_RESOURCE,
    state: "processing",
    ticketState: "none",
    ticketTokens: null,
  });
  const completedClaim = await requirePaymentSessionClaim(PAYMENT_ID, 60_000);
  await applyPaymentSessionClaim(completedClaim, {
    attendeeId: 42,
    completion: PAYMENT_COMPLETED_BOOKING,
    completionState: "completed",
    nextReconcileAt: null,
    result: READY_RESULT,
    resultState: "succeeded",
    session: SESSION_RESOURCE,
    state: "completed",
    ticketState: "ready",
    ticketTokens: ["ticket-local"],
  });
};

describeWithEnv("local payment redirect", { db: true }, () => {
  test("consumes callback tickets once and resolves a repeat without them", async () => {
    await storeCompletedPayment();

    const request = mockRequest(`/payment/success?payment_id=${PAYMENT_ID}`);
    const url = new URL(request.url);
    const first = await routePayment(request, url.pathname, request.method);
    if (first === null) throw new Error("Expected payment redirect route");

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(
      "/payment/success?tokens=ticket-local",
    );
    const [consumed] = await getPaymentSessions([PAYMENT_ID]);
    expect(consumed).toMatchObject({
      attendeeId: 42,
      ticketState: "consumed",
      ticketTokens: null,
    });

    const repeated = await routePayment(request, url.pathname, request.method);
    if (repeated === null)
      throw new Error("Expected repeated payment redirect");
    expect(repeated.status).toBe(200);
    expect(await repeated.text()).toContain('data-payment-result="success"');
  });

  test("returns a stable result when a completed payment lost its attendee", async () => {
    await storeCompletedPayment();
    await getDb().execute(
      "UPDATE payment_sessions SET attendee_id = NULL WHERE id = ?",
      [PAYMENT_ID],
    );

    const request = mockRequest(`/payment/success?payment_id=${PAYMENT_ID}`);
    const url = new URL(request.url);
    const response = await routePayment(request, url.pathname, request.method);
    if (response === null) throw new Error("Expected payment redirect route");

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("We could not find this payment.");
  });
});
