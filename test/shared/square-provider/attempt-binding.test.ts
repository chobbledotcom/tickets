import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  type PaymentAttemptConfig,
  paymentAttemptApi,
} from "#shared/payment-attempt.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { asSession } from "#test-utils/payment-session.ts";
import { constructTestWebhookEvent } from "#test-utils/square/webhook.ts";

const CONFIG_A = {
  accessToken: "square-attempt-token-a",
  currency: "USD",
  locationId: "square-attempt-location-a",
  sandbox: true,
  type: "square",
  webhookSignatureKey: "square-attempt-signature-a",
} as const satisfies PaymentAttemptConfig;

const CONFIG_B = {
  accessToken: "square-attempt-token-b",
  currency: "EUR",
  locationId: "square-attempt-location-b",
  sandbox: false,
  type: "square",
  webhookSignatureKey: "square-attempt-signature-b",
} as const satisfies PaymentAttemptConfig;

const globalSettingsFor = (config: typeof CONFIG_A | typeof CONFIG_B) => ({
  currency: config.currency,
  payment_provider: "square" as const,
  payment_provider_setting: "square" as const,
  square_access_token: config.accessToken,
  square_location_id: config.locationId,
  square_sandbox: config.sandbox,
  square_webhook_signature_key: config.webhookSignatureKey,
});

const metadata = {
  email: "buyer@example.com",
  items: '[{"e":1,"q":1,"p":0}]',
  name: "Buyer",
};

const squareResponse = (body: unknown): Response =>
  Response.json(body, { status: 200 });

const orderResponse = (suffix: "a" | "b", locationId: string): Response =>
  squareResponse({
    order: {
      created_at: "2026-08-06T09:00:00Z",
      id: `order-${suffix}`,
      location_id: locationId,
      metadata,
      state: "COMPLETED",
      tenders: [{ id: `tender-${suffix}`, payment_id: `payment-${suffix}` }],
      total_money: { amount: 1250, currency: suffix === "a" ? "USD" : "EUR" },
    },
  });

const paymentResponse = (
  suffix: "a" | "b",
  locationId: string,
  refunded = false,
): Response =>
  squareResponse({
    payment: {
      amount_money: { amount: 1250, currency: suffix === "a" ? "USD" : "EUR" },
      id: `payment-${suffix}`,
      location_id: locationId,
      order_id: `order-${suffix}`,
      ...(refunded
        ? { refunded_money: { amount: 1250, currency: "USD" } }
        : {}),
      status: "COMPLETED",
    },
  });

const signedEvent: WebhookEvent = {
  data: {
    object: {
      payment: {
        id: "payment-a",
        order_id: "order-a",
        status: "COMPLETED",
      },
    },
  },
  id: "event-a",
  type: "payment.updated",
};

const requestAuth = (init?: RequestInit): string | null =>
  new Headers(init?.headers).get("authorization");

test("binds every Square observation and settlement operation to one configuration", async () => {
  settings.setForTest(globalSettingsFor(CONFIG_A));
  setSuppressDebugLogs(false);
  using debug = spy(console, "debug");
  using error = spy(console, "error");
  const firstRequest = Promise.withResolvers<void>();
  const releaseFirstRequest = Promise.withResolvers<void>();
  const requests: Array<{
    authorization: string | null;
    method: string;
    url: string;
  }> = [];
  let paymentAReads = 0;

  using _fetch = stubFetch(async (url, init) => {
    requests.push({
      authorization: requestAuth(init),
      method: init?.method ?? "GET",
      url,
    });
    if (url.endsWith("/v2/orders/order-a")) {
      firstRequest.resolve();
      await releaseFirstRequest.promise;
      return orderResponse("a", CONFIG_A.locationId);
    }
    if (url.endsWith("/v2/orders/order-b")) {
      return orderResponse("b", CONFIG_B.locationId);
    }
    if (url.endsWith("/v2/payments/payment-a")) {
      paymentAReads += 1;
      return paymentResponse("a", CONFIG_A.locationId, paymentAReads === 3);
    }
    if (url.endsWith("/v2/payments/payment-b")) {
      return paymentResponse("b", CONFIG_B.locationId);
    }
    if (url.endsWith("/v2/refunds")) {
      return squareResponse({
        refund: {
          amount_money: { amount: 1250, currency: "USD" },
          id: "refund-a",
          payment_id: "payment-a",
          status: "FAILED",
        },
      });
    }
    throw new Error(`Unexpected Square request: ${url}`);
  });

  try {
    const attemptA = await paymentAttemptApi.bind(CONFIG_A);
    const sessionAPromise = attemptA.retrieveSession("order-a");
    await firstRequest.promise;
    settings.setForTest(globalSettingsFor(CONFIG_B));
    releaseFirstRequest.resolve();

    const sessionA = await sessionAPromise;
    expect(asSession(sessionA).id).toBe("order-a");

    const webhookUrl = "https://tickets.example/payment/webhook";
    const signed = await constructTestWebhookEvent(
      signedEvent,
      CONFIG_A.webhookSignatureKey,
      webhookUrl,
    );
    const verified = await attemptA.verifyWebhookSignature(
      signed.payload,
      signed.signature,
      webhookUrl,
      new TextEncoder().encode(signed.payload),
    );
    expect(verified).toEqual({ listing: signedEvent, valid: true });

    expect(await attemptA.refundPayment("payment-a")).toBe(false);
    expect(await attemptA.isPaymentRefunded("payment-a")).toBe(true);

    const attemptB = await paymentAttemptApi.bind(CONFIG_B);
    const sessionB = await attemptB.retrieveSession("order-b");
    expect(asSession(sessionB).id).toBe("order-b");

    const aRequests = requests.filter(({ url }) =>
      url.includes("squareupsandbox.com"),
    );
    const bRequests = requests.filter(({ url }) =>
      url.includes("connect.squareup.com"),
    );
    expect(aRequests).toHaveLength(5);
    expect(aRequests.map(({ authorization }) => authorization)).toEqual(
      Array(5).fill(`Bearer ${CONFIG_A.accessToken}`),
    );
    expect(aRequests.map(({ method }) => method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "GET",
    ]);
    expect(aRequests.map(({ url }) => url)).toEqual([
      "https://connect.squareupsandbox.com/v2/orders/order-a",
      "https://connect.squareupsandbox.com/v2/payments/payment-a",
      "https://connect.squareupsandbox.com/v2/payments/payment-a",
      "https://connect.squareupsandbox.com/v2/refunds",
      "https://connect.squareupsandbox.com/v2/payments/payment-a",
    ]);
    expect(bRequests.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${CONFIG_B.accessToken}`,
      `Bearer ${CONFIG_B.accessToken}`,
    ]);
    expect(bRequests.map(({ url }) => url)).toEqual([
      "https://connect.squareup.com/v2/orders/order-b",
      "https://connect.squareup.com/v2/payments/payment-b",
    ]);

    const privateValues = [
      CONFIG_A.accessToken,
      CONFIG_A.webhookSignatureKey,
      CONFIG_B.accessToken,
      CONFIG_B.webhookSignatureKey,
    ];
    const exposed = [
      JSON.stringify(sessionA),
      JSON.stringify(sessionB),
      JSON.stringify(attemptA),
      JSON.stringify(attemptB),
      JSON.stringify(debug.calls.map(({ args }) => args)),
      JSON.stringify(error.calls.map(({ args }) => args)),
    ].join("\n");
    for (const privateValue of privateValues) {
      expect(exposed).not.toContain(privateValue);
    }
    const serializedAttempts = JSON.stringify({ attemptA, attemptB });
    for (const privateClientPart of [
      "paymentLinks",
      "locations",
      "orders",
      "payments",
      "refunds",
      "squareupsandbox.com",
      "connect.squareup.com",
    ]) {
      expect(serializedAttempts).not.toContain(privateClientPart);
    }
  } finally {
    releaseFirstRequest.resolve();
    setSuppressDebugLogs(null);
  }
});
