import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import Stripe from "stripe";
import {
  createStripeClient,
  STRIPE_API_VERSION,
} from "#shared/stripe/client.ts";

type RecordedRequest = {
  authorization: string | null;
  body: string;
  contentType: string | null;
  method: string;
  path: string;
  version: string | null;
};

const checkout = {
  amount_total: 1000,
  created: 123,
  id: "cs_1",
  metadata: {},
  payment_intent: "pi_1",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_1",
};

const responseFor = (request: Request): Response => {
  const path = new URL(request.url).pathname;
  if (path === "/v1/balance") return Response.json({ livemode: false });
  if (path === "/v1/refunds") {
    return Response.json({ id: "re_1", status: "succeeded" });
  }
  if (path.startsWith("/v1/payment_intents/")) {
    return Response.json({
      id: "pi_1",
      latest_charge: { refunded: false },
    });
  }
  if (
    path === "/v1/checkout/sessions" ||
    path.startsWith("/v1/checkout/sessions/")
  ) {
    return Response.json(checkout);
  }
  if (path === "/v1/webhook_endpoints" && request.method === "GET") {
    return Response.json({
      data: [
        {
          enabled_events: ["checkout.session.completed"],
          id: "we_1",
          status: "enabled",
          url: "https://example.com/payment/webhook",
        },
      ],
    });
  }
  if (path.startsWith("/v1/webhook_endpoints")) {
    return Response.json({ id: "we_1", secret: "whsec_1" });
  }
  throw new Error(
    `Unexpected Stripe parity request: ${request.method} ${path}`,
  );
};

test("the small client matches stripe-node requests for every used operation", async () => {
  const requests: RecordedRequest[] = [];
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      onListen: ({ port }) => listening.resolve(port),
      port: 0,
    },
    async (request) => {
      requests.push({
        authorization: request.headers.get("authorization"),
        body: await request.text(),
        contentType: request.headers.get("content-type"),
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        version: request.headers.get("stripe-version"),
      });
      return responseFor(request);
    },
  );
  const port = await listening.promise;
  const official = new Stripe("sk_test_parity", {
    apiVersion: STRIPE_API_VERSION,
    host: "127.0.0.1",
    maxNetworkRetries: 0,
    port,
    protocol: "http",
  });
  const small = createStripeClient("sk_test_parity", {
    apiBase: `http://127.0.0.1:${port}`,
    maxNetworkRetries: 0,
  });
  const checkoutParams = {
    line_items: [
      {
        price_data: {
          currency: "gbp",
          product_data: { name: "Tea & cake" },
          unit_amount: 1000,
        },
        quantity: 1,
      },
    ],
    metadata: { order: "signed" },
    mode: "payment" as const,
    success_url: "https://example.com/success",
  };
  const webhookParams = {
    api_version: STRIPE_API_VERSION,
    enabled_events: ["checkout.session.completed" as const],
    url: "https://example.com/payment/webhook",
  } satisfies Stripe.WebhookEndpointCreateParams;
  const operations = [
    [
      () => official.checkout.sessions.create(checkoutParams),
      () => small.checkout.sessions.create(checkoutParams),
    ],
    [
      () => official.checkout.sessions.retrieve("cs_1"),
      () => small.checkout.sessions.retrieve("cs_1"),
    ],
    [
      () =>
        official.paymentIntents.retrieve("pi_1", { expand: ["latest_charge"] }),
      () =>
        small.paymentIntents.retrieve("pi_1", { expand: ["latest_charge"] }),
    ],
    [
      () => official.refunds.create({ payment_intent: "pi_1" }),
      () => small.refunds.create({ payment_intent: "pi_1" }),
    ],
    [() => official.balance.retrieve(), () => small.balance.retrieve()],
    [
      () => official.webhookEndpoints.list({ limit: 100 }),
      () => small.webhookEndpoints.list({ limit: 100 }),
    ],
    [
      () => official.webhookEndpoints.create(webhookParams),
      () => small.webhookEndpoints.create(webhookParams),
    ],
    [
      () => official.webhookEndpoints.del("we_1"),
      () => small.webhookEndpoints.del("we_1"),
    ],
  ] as const;

  try {
    for (const [runOfficial, runSmall] of operations) {
      await runOfficial();
      await runSmall();
    }
  } finally {
    await server.shutdown();
  }

  const pairs = Array.from({ length: operations.length }, (_, index) =>
    requests.slice(index * 2, index * 2 + 2),
  );
  for (const [officialRequest, smallRequest] of pairs) {
    expect(smallRequest).toEqual(officialRequest);
  }
});
