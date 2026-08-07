import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  type PaymentAttemptConfig,
  paymentAttemptApi,
} from "#shared/payment-attempt.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import {
  signedWebhook,
  stripeCheckoutSession,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import { asSession } from "#test-utils/payment-session.ts";
import { checkoutSessionEvent } from "#test-utils/webhooks.ts";

type StripeAttemptConfig = Extract<PaymentAttemptConfig, { type: "stripe" }>;

const configA: StripeAttemptConfig = {
  currency: "GBP",
  keyMode: "test",
  secretKey: "sk_test_attempt_a",
  type: "stripe",
  webhookSecret: "whsec_attempt_a",
};

const configB: StripeAttemptConfig = {
  currency: "USD",
  keyMode: "live",
  secretKey: "sk_live_attempt_b",
  type: "stripe",
  webhookSecret: "whsec_attempt_b",
};

const settingsFor = (config: StripeAttemptConfig) => ({
  currency: config.currency,
  payment_provider: "stripe" as const,
  payment_provider_setting: "stripe" as const,
  stripe_secret_key: config.secretKey,
  stripe_webhook_secret: config.webhookSecret,
});

interface ClientCall {
  client: "a" | "b";
  operation: "refund" | "session" | "status";
  reference: string;
}

const clientFor = (
  name: "a" | "b",
  calls: ClientCall[],
  sessionStarted: PromiseWithResolvers<void>,
  releaseSession: PromiseWithResolvers<void>,
): StripeClient => {
  const client = {
    balance: {
      retrieve: () =>
        Promise.resolve({ available: [], livemode: name === "b", pending: [] }),
    },
    checkout: {
      sessions: {
        create: () => Promise.reject(new Error("Checkout creation is unused")),
        retrieve: async (id: string) => {
          calls.push({ client: name, operation: "session", reference: id });
          if (name === "a") {
            sessionStarted.resolve();
            await releaseSession.promise;
          }
          return stripeCheckoutSession({
            currency: name === "a" ? "gbp" : "usd",
            id: `cs_${name}`,
            metadata: {
              email: `${name}@example.com`,
              items: '[{"e":1,"q":1,"p":0}]',
              name: `Buyer ${name.toUpperCase()}`,
            },
            payment_intent: `pi_${name}`,
          });
        },
      },
    },
    paymentIntents: {
      retrieveWithLatestCharge: (reference: string) => {
        calls.push({ client: name, operation: "status", reference });
        return Promise.resolve({
          id: reference,
          latest_charge: { refunded: name === "a" },
        });
      },
    },
    privateClientMarker: `private-client-${name}`,
    refunds: {
      create: ({ payment_intent }: { payment_intent?: string }) => {
        calls.push({
          client: name,
          operation: "refund",
          reference: payment_intent ?? "",
        });
        return Promise.resolve({
          id: `re_${name}`,
          status: name === "a" ? ("failed" as const) : ("succeeded" as const),
        });
      },
    },
    webhookEndpoints: {
      create: () => Promise.reject(new Error("Webhook setup is unused")),
      del: () => Promise.reject(new Error("Webhook deletion is unused")),
      list: () => Promise.reject(new Error("Webhook listing is unused")),
    },
  };
  return client;
};

describeStripe("createStripePaymentAttempt", () => {
  test("keeps its client, mode, and webhook secret after settings change", async () => {
    settings.setForTest(settingsFor(configA));
    const sessionStarted = Promise.withResolvers<void>();
    const releaseSession = Promise.withResolvers<void>();
    const calls: ClientCall[] = [];
    const clientA = clientFor("a", calls, sessionStarted, releaseSession);
    const clientB = clientFor("b", calls, sessionStarted, releaseSession);
    using _create = stub(stripeClientRuntime, "create", (secretKey) => {
      if (secretKey === configA.secretKey) return clientA;
      if (secretKey === configB.secretKey) return clientB;
      throw new Error(`Unexpected Stripe key: ${secretKey}`);
    });

    const attemptA = await paymentAttemptApi.bind(configA);
    const sessionAPromise = attemptA.retrieveSession("cs_a");
    await sessionStarted.promise;

    settings.setForTest(settingsFor(configB));
    const attemptB = await paymentAttemptApi.bind(configB);
    releaseSession.resolve();

    const sessionA = asSession(await sessionAPromise);
    const sessionB = asSession(await attemptB.retrieveSession("cs_b"));
    const eventA = checkoutSessionEvent({
      amountTotal: 1000,
      eventId: "evt_a",
      metadata: {},
      sessionId: "cs_a",
    });
    const eventB = checkoutSessionEvent({
      amountTotal: 1000,
      eventId: "evt_b",
      metadata: {},
      sessionId: "cs_b",
    });
    const signedA = await signedWebhook(eventA, configA.webhookSecret);
    const signedB = await signedWebhook(eventB, configB.webhookSecret);
    const verifiedA = await attemptA.verifyWebhookSignature(
      signedA.payload,
      signedA.signature,
      "https://example.com/payment/webhook",
      new TextEncoder().encode(signedA.payload),
    );
    const verifiedB = await attemptB.verifyWebhookSignature(
      signedB.payload,
      signedB.signature,
      "https://example.com/payment/webhook",
      new TextEncoder().encode(signedB.payload),
    );
    const wrongAttemptDiagnostic = await attemptA.verifyWebhookSignature(
      signedB.payload,
      signedB.signature,
      "https://example.com/payment/webhook",
      new TextEncoder().encode(signedB.payload),
    );

    expect(sessionA).toMatchObject({
      currency: "GBP",
      id: "cs_a",
      paymentReference: "pi_a",
    });
    expect(sessionB).toMatchObject({
      currency: "USD",
      id: "cs_b",
      paymentReference: "pi_b",
    });
    expect(verifiedA).toEqual({ listing: eventA, valid: true });
    expect(verifiedB).toEqual({ listing: eventB, valid: true });
    expect(wrongAttemptDiagnostic).toEqual({
      error: "Signature verification failed",
      valid: false,
    });
    expect(await attemptA.refundPayment("pi_refund_a")).toBe(false);
    expect(await attemptA.isPaymentRefunded("pi_refund_a")).toBe(true);
    expect(await attemptB.refundPayment("pi_refund_b")).toBe(true);
    expect(await attemptB.isPaymentRefunded("pi_refund_b")).toBe(false);
    expect(calls).toEqual([
      { client: "a", operation: "session", reference: "cs_a" },
      { client: "b", operation: "session", reference: "cs_b" },
      { client: "a", operation: "refund", reference: "pi_refund_a" },
      { client: "a", operation: "status", reference: "pi_refund_a" },
      { client: "b", operation: "refund", reference: "pi_refund_b" },
      { client: "b", operation: "status", reference: "pi_refund_b" },
    ]);

    const exposed = JSON.stringify({
      attemptA,
      attemptB,
      sessionA,
      sessionB,
      wrongAttemptDiagnostic,
    });
    for (const privateValue of [
      configA.secretKey,
      configA.webhookSecret,
      configB.secretKey,
      configB.webhookSecret,
      "private-client-a",
      "private-client-b",
    ]) {
      expect(exposed).not.toContain(privateValue);
    }
  });
});
