import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stripeResponseFor } from "#test-utils/stripe/responses.ts";
import { refundKeySentWith, withStripeWire } from "./request/fixtures.ts";

test("maps every used Stripe operation to its endpoint", async () => {
  const requests = await withStripeWire(
    [
      (url, init) =>
        stripeResponseFor(new URL(url).pathname, init?.method ?? "GET"),
    ],
    async (client, wire) => {
      await client.balance.retrieve();
      await client.checkout.sessions.create({
        cancel_url: "https://example.com/cancel",
        line_items: [],
        metadata: {},
        mode: "payment",
        payment_method_types: ["card"],
        success_url: "https://example.com/success",
      });
      await client.checkout.sessions.retrieve("cs/1");
      await client.paymentIntents.retrieveWithLatestCharge("pi/1");
      await client.refunds.create({ amount: 1000, payment_intent: "pi_1" });
      await client.webhookEndpoints.list();
      await client.webhookEndpoints.list("we/cursor");
      await client.webhookEndpoints.create({
        api_version: "2026-04-22.dahlia",
        enabled_events: ["checkout.session.completed"],
        url: "https://example.com/payment/webhook",
      });
      await client.webhookEndpoints.del("we/1");
      return wire.sent.map(({ init, url }) => ({
        body: String(init.body ?? ""),
        method: init.method ?? "GET",
        path: new URL(url).pathname + new URL(url).search,
      }));
    },
    { maxNetworkRetries: 0 },
  );

  expect(requests).toEqual([
    { body: "", method: "GET", path: "/v1/balance" },
    {
      body: "cancel_url=https%3A%2F%2Fexample.com%2Fcancel&mode=payment&payment_method_types[0]=card&success_url=https%3A%2F%2Fexample.com%2Fsuccess",
      method: "POST",
      path: "/v1/checkout/sessions",
    },
    { body: "", method: "GET", path: "/v1/checkout/sessions/cs%2F1" },
    {
      body: "",
      method: "GET",
      path: "/v1/payment_intents/pi%2F1?expand[0]=latest_charge",
    },
    {
      body: "amount=1000&payment_intent=pi_1",
      method: "POST",
      path: "/v1/refunds",
    },
    { body: "", method: "GET", path: "/v1/webhook_endpoints?limit=100" },
    {
      body: "",
      method: "GET",
      path: "/v1/webhook_endpoints?limit=100&starting_after=we%2Fcursor",
    },
    {
      body: "api_version=2026-04-22.dahlia&enabled_events[0]=checkout.session.completed&url=https%3A%2F%2Fexample.com%2Fpayment%2Fwebhook",
      method: "POST",
      path: "/v1/webhook_endpoints",
    },
    { body: "", method: "DELETE", path: "/v1/webhook_endpoints/we%2F1" },
  ]);
});

test("sends the supplied idempotency key as the Idempotency-Key header on a refund", async () => {
  expect(await refundKeySentWith("stable-refund-key")).toBe(
    "stable-refund-key",
  );
});
