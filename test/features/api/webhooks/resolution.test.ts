import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
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
import { settings } from "#shared/db/settings.ts";
import { resolvePaymentAccount } from "#shared/payment-runtime/account.ts";
import type { ProviderRead } from "#shared/payment-state/observation.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  CHARGE_RESOURCE,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
  SESSION_RESOURCE,
  sessionProgress,
} from "#test/shared/db/payments/fixtures.ts";
import { paymentProviderRead } from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { required } from "#test-utils/required.ts";

const notice = {
  eventId: "evt-runtime",
  resource: SESSION_RESOURCE,
  type: "checkout.session.completed",
};

/** What the provider answers when it cannot tell us about this payment. */
const PROVIDER_UNAVAILABLE_READ: ProviderRead = {
  ownership: {
    localPaymentId: PAYMENT_ID,
    method: "staged",
    stageId: SESSION_RESOURCE.id,
  },
  reason: "provider_unavailable",
  requested: SESSION_RESOURCE,
  status: "unavailable",
};

const sendWebhook = async (): Promise<Response> => {
  const request = new Request("https://example.com/payment/webhook", {
    body: "{}",
    headers: { "stripe-signature": "signed" },
    method: "POST",
  });
  const response = await routePayment(request, "/payment/webhook", "POST");
  assert(response !== null);
  return response;
};

const sendRedirect = async (): Promise<Response> => {
  const request = new Request(
    `https://example.com/payment/success?session_id=${SESSION_RESOURCE.id}`,
  );
  const response = await routePayment(request, "/payment/success", "GET");
  assert(response !== null);
  return response;
};

const storedPayment = async () => {
  const [payment] = await getPaymentSessions([PAYMENT_ID]);
  return required(payment, "the stored payment");
};

describeWithEnv("payment webhook reconciliation", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  const setUpPayment = async (): Promise<void> => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_webhook-runtime",
    });
    const account = await resolvePaymentAccount("stripe");
    await createPaymentSession(
      { ...paymentSessionInput(), accountId: account.accountId },
      PAYMENT_TIME,
    );
  };

  /** Set the payment up, make the provider answer with this read, and ask the
   *  given route what it made of it. */
  const runWithProviderRead =
    (send: () => Promise<Response>) =>
    async (read: ProviderRead): Promise<Response> => {
      await setUpPayment();
      using _verify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () => Promise.resolve({ notice, valid: true }),
      );
      using _read = stub(stripePaymentProvider, "readPayment", () =>
        Promise.resolve(read),
      );
      return await send();
    };

  const runWebhook = runWithProviderRead(sendWebhook);
  const runRedirect = runWithProviderRead(sendRedirect);

  test("persists pending before acknowledging it", async () => {
    const response = await runWebhook(
      paymentProviderRead({ charges: undefined, status: "pending" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "pending" });
    expect((await storedPayment()).state).toBe("pending");
  });

  test("persists retry evidence before returning 503", async () => {
    const response = await runWebhook(PROVIDER_UNAVAILABLE_READ);

    expect(response.status).toBe(503);
    const cases = await getDb().execute(
      "SELECT reason, state FROM payment_cases WHERE payment_id = ?",
      [PAYMENT_ID],
    );
    expect(cases.rows).toEqual([
      { reason: "provider_unavailable", state: "retrying" },
    ]);
  });

  test("returns 503 when a verified unavailable callback has no local payment", async () => {
    settings.setForTest({
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_webhook-runtime",
    });
    using _verify = stub(stripePaymentProvider, "verifyWebhookSignature", () =>
      Promise.resolve({ notice, valid: true }),
    );
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve({
        reason: "provider_unavailable" as const,
        requested: SESSION_RESOURCE,
        status: "unavailable" as const,
      }),
    );

    const response = await sendWebhook();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "retry" });
  });

  test("persists an owned conflict before acknowledging it", async () => {
    const response = await runWebhook(
      paymentProviderRead({
        providerTotal: { amount: 900, currency: "GBP" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "needs_action" });
    expect((await storedPayment()).state).toBe("needs_action");
  });

  test("serializes a redirect racing the same webhook", async () => {
    await setUpPayment();
    let releaseRead = (): void => {
      throw new Error("Provider read was not held");
    };
    let markEntered = (): void => {
      throw new Error("Provider read did not start");
    };
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    using _verify = stub(stripePaymentProvider, "verifyWebhookSignature", () =>
      Promise.resolve({ notice, valid: true }),
    );
    using read = stub(stripePaymentProvider, "readPayment", async () => {
      markEntered();
      await held;
      return paymentProviderRead({ charges: undefined, status: "pending" });
    });
    const webhook = sendWebhook();
    await entered;
    const redirectRequest = new Request(
      `https://example.com/payment/success?session_id=${SESSION_RESOURCE.id}`,
    );
    const redirect = await routePayment(
      redirectRequest,
      "/payment/success",
      "GET",
    );
    assert(redirect !== null);

    expect(redirect.status).toBe(409);
    expect(read.calls).toHaveLength(1);
    releaseRead();
    expect((await webhook).status).toBe(200);
  });

  test("a redirect on a payment the provider is still holding says to wait", async () => {
    const response = await runRedirect(
      paymentProviderRead({ charges: undefined, status: "pending" }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain(
      "Your payment is still being processed.",
    );
  });

  test("a redirect the provider cannot answer asks the buyer to try again", async () => {
    const response = await runRedirect(PROVIDER_UNAVAILABLE_READ);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain(
      "We cannot check this payment right now.",
    );
  });

  test("a redirect on a refunded payment says so instead of a ticket", async () => {
    await setUpPayment();
    await applyPaymentSessionClaim(
      await requirePaymentSessionClaim(PAYMENT_ID, 60_000),
      sessionProgress({ state: "processing" }),
    );
    using _read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(
        paymentProviderRead({
          charges: [
            {
              captured: { amount: 1_000, currency: "GBP" },
              confirmedRefunded: { amount: 1_000, currency: "GBP" },
              refunds: [],
              resource: CHARGE_RESOURCE,
            },
          ],
        }),
      ),
    );

    const response = await sendRedirect();

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("This payment has been refunded.");
  });

  test("a redirect on a payment the provider disagrees about needs review", async () => {
    const response = await runRedirect(
      paymentProviderRead({
        providerTotal: { amount: 900, currency: "GBP" },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Your payment needs review.");
  });
});
