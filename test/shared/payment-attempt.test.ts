import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  getExistingPaymentAttempt,
  type PaymentAttempt,
  type PaymentAttemptConfig,
  paymentAttemptApi,
} from "#shared/payment-attempt.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  joinedStubs,
  testPaymentAttempt,
} from "#test-utils/payment-attempt.ts";

const attemptFor = (config: PaymentAttemptConfig): PaymentAttempt => ({
  checkoutCompletedEventType: `${config.type}.completed`,
  currency: config.currency,
  isPaymentRefunded: () => Promise.resolve(false),
  refundPayment: () => Promise.resolve(false),
  requiresWebhookSignature: config.type !== "sumup",
  resolveWebhookSession: () => Promise.resolve(null),
  retrieveSession: () => Promise.resolve(null),
  type: config.type,
  verifyWebhookSignature: () =>
    Promise.resolve({ error: "not verified", valid: false }),
});

const stripeSettings = {
  currency: "GBP",
  payment_provider: "stripe" as const,
  payment_provider_setting: "stripe" as const,
  stripe_secret_key: "sk_test_account_a",
  stripe_webhook_secret: "whsec_a",
};

const squareSettings = {
  currency: "USD",
  payment_provider: "square" as const,
  payment_provider_setting: "square" as const,
  square_access_token: "square-token-b",
  square_location_id: "location-b",
  square_sandbox: false,
  square_webhook_signature_key: "square-signature-b",
};

describeWithEnv("payment attempt configuration", { db: true }, () => {
  test("keeps one provider and configuration while settings change", async () => {
    settings.setForTest(stripeSettings);
    const bindingStarted = Promise.withResolvers<void>();
    const continueBinding = Promise.withResolvers<void>();
    const configs: PaymentAttemptConfig[] = [];
    using _bind = stub(paymentAttemptApi, "bind", async (config) => {
      configs.push(config);
      bindingStarted.resolve();
      await continueBinding.promise;
      return attemptFor(config);
    });

    const firstPromise = getExistingPaymentAttempt();
    await bindingStarted.promise;
    settings.setForTest(squareSettings);
    continueBinding.resolve();

    const first = await firstPromise;
    expect(first?.type).toBe("stripe");
    expect(first?.currency).toBe("GBP");
    expect(configs[0]).toEqual({
      currency: "GBP",
      keyMode: "test",
      secretKey: "sk_test_account_a",
      type: "stripe",
      webhookSecret: "whsec_a",
    });

    const second = await getExistingPaymentAttempt();
    expect(second?.type).toBe("square");
    expect(second?.currency).toBe("USD");
    expect(configs[1]).toEqual({
      accessToken: "square-token-b",
      currency: "USD",
      locationId: "location-b",
      sandbox: false,
      type: "square",
      webhookSignatureKey: "square-signature-b",
    });
  });

  test("binds SumUp key, merchant, and currency as one value", async () => {
    settings.setForTest({
      currency: "EUR",
      payment_provider: "sumup",
      payment_provider_setting: "sumup",
      sumup_api_key: "sup_sk_a",
      sumup_merchant_code: "merchant-a",
    });
    const configs: PaymentAttemptConfig[] = [];
    using _bind = stub(paymentAttemptApi, "bind", (config) => {
      configs.push(config);
      return Promise.resolve(attemptFor(config));
    });

    await getExistingPaymentAttempt();

    expect(configs).toEqual([
      {
        apiKey: "sup_sk_a",
        currency: "EUR",
        merchantCode: "merchant-a",
        type: "sumup",
      },
    ]);
  });

  test("returns operations without credentials or clients", async () => {
    settings.setForTest(stripeSettings);
    const client = { privateClient: true };
    using _bind = stub(paymentAttemptApi, "bind", (config) => {
      const attempt = attemptFor(config);
      void client;
      return Promise.resolve(attempt);
    });

    const attempt = await getExistingPaymentAttempt();
    const exposed = JSON.stringify(attempt);

    expect(exposed).not.toContain("sk_test_account_a");
    expect(exposed).not.toContain("whsec_a");
    expect(exposed).not.toContain("privateClient");
  });

  test("provides inert defaults for provider-independent tests", async () => {
    const attempt = testPaymentAttempt();

    expect(await attempt.refundPayment("payment")).toBe(false);
    expect(await attempt.isPaymentRefunded("payment")).toBe(false);
    expect(await attempt.retrieveSession("session")).toBeNull();
    expect(
      await attempt.resolveWebhookSession({
        data: { object: {} },
        id: "event",
        type: "event",
      }),
    ).toBeNull();
    expect(
      await attempt.verifyWebhookSignature("", "", "", new Uint8Array()),
    ).toEqual({ error: "Invalid signature", valid: false });
  });

  test("restores joined stubs only once", () => {
    let restoreCount = 0;
    const joined = joinedStubs(
      { calls: [], restore: () => restoreCount++ },
      { restore: () => restoreCount++ },
    );

    joined.restore();
    joined.restore();

    expect(restoreCount).toBe(2);
  });
});
