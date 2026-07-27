import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaim,
  requirePaymentSessionClaim,
} from "#shared/db/payments/claims.ts";
import {
  createPaymentSession,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import {
  createPaymentCheckout,
  resumePaymentCheckout,
} from "#shared/payment-runtime/create.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  PAYMENT_CHECKOUT_CREATE,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
} from "#test/shared/db/payments/fixtures.ts";
import {
  checkoutIntent,
  stubBlockedSquareCheckoutRetry,
  stubUncertainSquareCheckout,
} from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const squareResource = {
  id: "square-order-resumed",
  kind: "square_order" as const,
  provider: "square" as const,
};

const createdProgress = (session: typeof squareResource) => ({
  attendeeId: null,
  completion: null,
  completionState: "none" as const,
  nextReconcileAt: null,
  result: null,
  resultState: "none" as const,
  session,
  state: "pending" as const,
  ticketState: "none" as const,
  ticketTokens: null,
});

describeWithEnv("payment runtime create retry", { db: true }, () => {
  beforeEach(() => {
    settings.setForTest({
      booking_fee: "0",
      currency: "GBP",
      payment_provider: "square",
      square_access_token: "square-token",
      square_location_id: "location-one",
    });
  });

  afterEach(() => settings.clearTestOverrides());

  test("resumes a lost response with the exact snapshot and local key", async () => {
    const submitted: PaymentCheckoutCreateSnapshot[] = [];
    using _create = stub(
      squarePaymentProvider,
      "createCheckout",
      (checkout: PaymentCheckoutCreateSnapshot) => {
        submitted.push(checkout);
        return Promise.resolve(
          submitted.length === 1
            ? null
            : {
                checkoutUrl: "https://square.example/resumed",
                session: squareResource,
                sessionId: squareResource.id,
              },
        );
      },
    );

    expect(
      await createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).toBeNull();
    const first = submitted[0]!;
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_other_active_provider",
    });

    expect(await resumePaymentCheckout(first.localPaymentId)).toEqual({
      checkoutUrl: "https://square.example/resumed",
      sessionId: squareResource.id,
    });
    expect(submitted).toEqual([first, first]);
    expect((await getPaymentSessions([first.localPaymentId]))[0]).toMatchObject(
      { checkoutCreate: null, session: squareResource },
    );
  });

  test("requires an existing created payment with checkout creation data", async () => {
    await expect(resumePaymentCheckout("missing-payment")).rejects.toThrow(
      "Payment session missing-payment was not found",
    );
    await createPaymentSession(
      paymentSessionInput(PAYMENT_ID, null),
      PAYMENT_TIME,
    );

    await expect(resumePaymentCheckout(PAYMENT_ID)).rejects.toThrow(
      `Payment session ${PAYMENT_ID} has no checkout creation data`,
    );
  });

  test("keeps the snapshot due when stored account lookup is unavailable", async () => {
    settings.setForTest({ stripe_secret_key: "sk_test_retry_unavailable" });
    await createPaymentSession(
      {
        ...paymentSessionInput(PAYMENT_ID, null),
        checkoutCreate: PAYMENT_CHECKOUT_CREATE,
      },
      PAYMENT_TIME,
    );
    using _account = stub(stripeApi, "retrieveAccount", () =>
      Promise.resolve(null),
    );

    await expect(resumePaymentCheckout(PAYMENT_ID)).rejects.toThrow(
      "Stripe payment account is unavailable",
    );
    expect((await getPaymentSessions([PAYMENT_ID]))[0]).toMatchObject({
      checkoutCreate: PAYMENT_CHECKOUT_CREATE,
      state: "created",
    });
  });

  test("allows only one concurrent resume provider call", async () => {
    const checkout = stubBlockedSquareCheckoutRetry({
      checkoutUrl: "https://square.example/resumed",
      session: squareResource,
      sessionId: squareResource.id,
    });
    using _create = checkout.checkout;
    await createPaymentCheckout(checkoutIntent(), "https://tickets.example");
    const paymentId = checkout.requireCaptured().localPaymentId;

    const first = resumePaymentCheckout(paymentId);
    await checkout.retryStarted;
    const second = resumePaymentCheckout(paymentId);
    checkout.releaseRetry();

    expect(await first).toMatchObject({ sessionId: squareResource.id });
    expect(await second).toBeNull();
    expect(checkout.calls()).toBe(2);
  });

  test("does not create after a callback attaches the provider session", async () => {
    const checkout = stubUncertainSquareCheckout();
    using _create = checkout.checkout;
    await createPaymentCheckout(checkoutIntent(), "https://tickets.example");
    const paymentId = checkout.requireCaptured().localPaymentId;
    const claim = await requirePaymentSessionClaim(paymentId, 60_000);
    await applyPaymentSessionClaim(claim, createdProgress(squareResource));

    expect(await resumePaymentCheckout(paymentId)).toBeNull();
    expect(checkout.calls()).toBe(1);
    expect(
      (await getPaymentSessions([paymentId]))[0]?.checkoutCreate,
    ).toBeNull();
  });

  test("clears the snapshot when stored provider configuration changed", async () => {
    const checkout = stubUncertainSquareCheckout();
    using _create = checkout.checkout;
    await createPaymentCheckout(checkoutIntent(), "https://tickets.example");
    const paymentId = checkout.requireCaptured().localPaymentId;
    settings.setForTest({ square_location_id: "location-two" });

    expect(await resumePaymentCheckout(paymentId)).toEqual({
      error: "Square payment account or mode changed",
    });
    expect(checkout.calls()).toBe(1);
    expect((await getPaymentSessions([paymentId]))[0]).toMatchObject({
      checkoutCreate: null,
      nextReconcileAt: null,
      state: "failed",
    });
  });

  test("a stale resume owner cannot attach its response", async () => {
    const checkout = stubBlockedSquareCheckoutRetry({
      checkoutUrl: "https://square.example/stale",
      session: squareResource,
      sessionId: squareResource.id,
    });
    using _create = checkout.checkout;
    await createPaymentCheckout(checkoutIntent(), "https://tickets.example");
    const paymentId = checkout.requireCaptured().localPaymentId;
    const retry = resumePaymentCheckout(paymentId);
    await checkout.retryStarted;
    await getDb().execute(
      "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
      [paymentId],
    );
    const replacement = await requirePaymentSessionClaim(paymentId, 60_000);
    const replacementResource = {
      ...squareResource,
      id: "square-callback-first",
    };
    await applyPaymentSessionClaim(
      replacement,
      createdProgress(replacementResource),
    );
    checkout.releaseRetry();

    await expect(retry).rejects.toThrow(
      `Lost payment session lease for ${paymentId}`,
    );
    expect((await getPaymentSessions([paymentId]))[0]).toMatchObject({
      checkoutCreate: null,
      session: replacementResource,
    });
  });
});
