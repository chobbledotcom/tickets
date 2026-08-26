import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import type { StripeCheckoutSessionCreateParams } from "#shared/stripe/client.ts";
import {
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
} from "#shared/stripe/request.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import type { FetchReply } from "#test-utils/fetch-stub.ts";
import { stripeCheckoutSession } from "#test-utils/stripe/fixtures.ts";
import {
  refundKeySentWith,
  unreadableResponse,
  WIRE_SECRET_KEY,
  withStripeWire,
} from "./request/fixtures.ts";

const checkoutParams = (): StripeCheckoutSessionCreateParams => ({
  cancel_url: "https://example.com/cancel",
  line_items: [
    {
      price_data: {
        currency: "gbp",
        product_data: { name: "Tea & cake" },
        unit_amount: 1000,
      },
      quantity: 2,
    },
  ],
  metadata: { order: "signed" },
  mode: "payment",
  payment_method_types: ["card"],
  success_url: "https://example.com/success",
});

/** One retried checkout: the bodies, keys, and waits it put on the wire. */
const retriedCheckout = (firstAttempt: FetchReply) =>
  withStripeWire(
    [firstAttempt, Response.json(stripeCheckoutSession())],
    async (client, wire) => {
      await client.checkout.sessions.create(checkoutParams());
      return {
        bodies: wire.sent.map(({ init }) => init.body),
        keys: wire.keys(),
        waits: wire.waits(),
      };
    },
    { maxNetworkRetries: 1 },
  );

const expectTwoCountedCheckoutAttempts = async (
  firstAttempt: FetchReply,
): Promise<void> => {
  const usage = await withStripeWire(
    [firstAttempt, Response.json(stripeCheckoutSession())],
    (client) =>
      runWithSubrequestBudget(async () => {
        await client.checkout.sessions.create(checkoutParams());
        return getSubrequestUsage();
      }),
    { maxNetworkRetries: 1 },
  );

  expect(usage).toEqual({ database: 0, external: 2, total: 2 });
};

describe("Stripe request transport", () => {
  test("keeps the production API version and retry limits explicit", () => {
    expect(STRIPE_API_VERSION).toBe("2026-04-22.dahlia");
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
    expect(REFUND_NETWORK_RETRIES.stripe).toBe(0);
  });

  test("refund reads and sends can disable the client's automatic retries", async () => {
    const busy = () =>
      Response.json({ error: { message: "try again" } }, { status: 500 });

    // Two calls the configured client would have asked three times each.
    const attempts = await withStripeWire(
      [busy],
      async (client, wire) => {
        await expect(
          client.paymentIntents.retrieveWithLatestCharge("pi_retry", {
            maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe,
          }),
        ).rejects.toThrow();
        await expect(
          client.refunds.create(
            { amount: 1000, payment_intent: "pi_retry" },
            "stable-key",
            { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
          ),
        ).rejects.toThrow();
        return wire.sent.length;
      },
      { maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES },
    );

    expect(attempts).toBe(2);
  });

  test("sends versioned nested form requests with bearer authentication", async () => {
    const sent = await withStripeWire(
      [() => Response.json(stripeCheckoutSession())],
      async (client, wire) => {
        await client.checkout.sessions.create(checkoutParams());
        return wire.sent[0]!;
      },
      { maxNetworkRetries: 0 },
    );

    expect(sent.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(sent.init.method).toBe("POST");
    expect(sent.init.body).toBe(
      "cancel_url=https%3A%2F%2Fexample.com%2Fcancel&line_items[0][price_data][currency]=gbp&line_items[0][price_data][product_data][name]=Tea%20%26%20cake&line_items[0][price_data][unit_amount]=1000&line_items[0][quantity]=2&metadata[order]=signed&mode=payment&payment_method_types[0]=card&success_url=https%3A%2F%2Fexample.com%2Fsuccess",
    );
    const headers = new Headers(sent.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${WIRE_SECRET_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(headers.has("idempotency-key")).toBe(false);
  });

  test("reuses one idempotency key and body across an instant retry", async () => {
    const wire = await retriedCheckout(new Response("busy", { status: 500 }));

    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[0]).toBe(wire.bodies[1]);
    expect(wire.keys[0]).toBe(wire.keys[1]);
    expect(wire.waits).toEqual([500]);
  });

  test("counts every Stripe retry against the shared request budget", async () => {
    await expectTwoCountedCheckoutAttempts(
      new Response("busy", { status: 500 }),
    );
  });

  test("counts a rejected Stripe transport before retrying", async () => {
    await expectTwoCountedCheckoutAttempts(
      new TypeError("network unavailable"),
    );
  });

  test("blocks Stripe before transport when no external allowance remains", async () => {
    const sent = await withStripeWire(
      [() => Response.json({ livemode: false })],
      async (client, wire) => {
        await expect(
          runWithSubrequestBudget(() =>
            withSubrequestAllowance(
              { database: 0, external: 0, total: 0 },
              () => client.balance.retrieve(),
            ),
          ),
        ).rejects.toThrow(
          "Blocked external operation: fetch https://api.stripe.com",
        );
        return wire.sent.length;
      },
    );

    expect(sent).toBe(0);
  });

  test("reuses the POST body and idempotency key after a response body read failure", async () => {
    const wire = await retriedCheckout(
      unreadableResponse(new TypeError("body disconnected")),
    );

    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[0]).toBe(wire.bodies[1]);
    expect(wire.keys[0]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(wire.keys[1]).toBe(wire.keys[0]);
    expect(wire.waits).toEqual([500]);
  });

  test("uses a different idempotency key for each POST operation", async () => {
    const keys = await withStripeWire(
      [() => Response.json(stripeCheckoutSession())],
      async (client, wire) => {
        await Promise.all([
          client.checkout.sessions.create(checkoutParams()),
          client.checkout.sessions.create(checkoutParams()),
        ]);
        return wire.keys();
      },
      { maxNetworkRetries: 1 },
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(keys[1]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("adds an idempotency key when exactly one retry is allowed", async () => {
    const keys = await withStripeWire(
      [() => Response.json(stripeCheckoutSession())],
      async (client, wire) => {
        await client.checkout.sessions.create(checkoutParams());
        return wire.keys();
      },
      { maxNetworkRetries: 1 },
    );

    expect(keys[0]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
  });

  test("treats an empty-string override as no key", async () => {
    expect(await refundKeySentWith("")).toBeNull();
  });
});
