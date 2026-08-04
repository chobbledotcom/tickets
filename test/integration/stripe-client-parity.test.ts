import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import Stripe from "stripe";
import { createStripeClient } from "#shared/stripe/client.ts";
import { STRIPE_API_VERSION } from "#shared/stripe/request.ts";
import { stripeResponseFor } from "#test/test-utils/stripe/responses.ts";

type RecordedRequest = {
  authorization: string | null;
  body: string;
  contentType: string | null;
  method: string;
  path: string;
  version: string | null;
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
      return stripeResponseFor(new URL(request.url).pathname, request.method);
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
    cancel_url: "https://example.com/cancel",
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
    metadata: { order: "signed[2026]" },
    mode: "payment" as const,
    payment_method_types: ["card"] as ["card"],
    success_url: "https://example.com/success",
  };
  const webhookParams = {
    api_version: STRIPE_API_VERSION as NonNullable<
      Stripe.WebhookEndpointCreateParams["api_version"]
    >,
    enabled_events: ["checkout.session.completed"] as [
      "checkout.session.completed",
    ],
    url: "https://example.com/payment/webhook",
  };
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
      () => small.paymentIntents.retrieveWithLatestCharge("pi_1"),
    ],
    [
      () => official.refunds.create({ payment_intent: "pi_1" }),
      () => small.refunds.create({ payment_intent: "pi_1" }),
    ],
    [() => official.balance.retrieve(), () => small.balance.retrieve()],
    [
      () => official.webhookEndpoints.list({ limit: 100 }),
      () => small.webhookEndpoints.list(),
    ],
    [
      () =>
        official.webhookEndpoints.list({
          limit: 100,
          starting_after: "we_1",
        }),
      () => small.webhookEndpoints.list("we_1"),
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

test("the parity server rejects an operation without a fixture", () => {
  expect(() => stripeResponseFor("/v1/unknown", "GET")).toThrow(
    "Unexpected Stripe test request: GET /v1/unknown",
  );
});
