import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createStripeClient,
  type StripeCheckoutSessionCreateParams,
} from "#shared/stripe/client.ts";
import {
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
} from "#shared/stripe/request.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { refundHeaderProbe } from "#test/shared/stripe/refund-header-probe.ts";
import { unreadableResponse } from "#test/shared/stripe/request/fixtures.ts";
import { stripeCheckoutSession } from "#test/test-utils/stripe/fixtures.ts";

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

const recordingCheckout = (
  responses: (Error | Response)[],
  maxNetworkRetries: number,
) => {
  const requests: RequestInit[] = [];
  const waits: number[] = [];
  const client = createStripeClient("sk_test_secret", {
    fetch: (_input, init = {}) => {
      requests.push(init);
      const response = responses.shift();
      if (!response) throw new Error("No Stripe response left");
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    },
    maxNetworkRetries,
    random: () => 0,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { client, requests, waits };
};

const expectTwoCountedCheckoutAttempts = async (
  firstAttempt: Error | Response,
): Promise<void> => {
  const { client } = recordingCheckout(
    [firstAttempt, Response.json(stripeCheckoutSession())],
    1,
  );

  await runWithSubrequestBudget(async () => {
    await client.checkout.sessions.create(checkoutParams());
    expect(getSubrequestUsage()).toEqual({
      database: 0,
      external: 2,
      total: 2,
    });
  });
};

describe("Stripe request transport", () => {
  test("keeps the production timeout and retry limits explicit", () => {
    expect(STRIPE_API_VERSION).toBe("2026-04-22.dahlia");
    expect(STRIPE_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
  });

  test("sends versioned nested form requests with bearer authentication", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = createStripeClient("sk_test_secret", {
      fetch: (input, init = {}) => {
        captured = { init, url: String(input) };
        return Promise.resolve(Response.json(stripeCheckoutSession()));
      },
      maxNetworkRetries: 0,
    });

    await client.checkout.sessions.create(checkoutParams());

    expect(captured?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.body).toBe(
      "cancel_url=https%3A%2F%2Fexample.com%2Fcancel&line_items[0][price_data][currency]=gbp&line_items[0][price_data][product_data][name]=Tea%20%26%20cake&line_items[0][price_data][unit_amount]=1000&line_items[0][quantity]=2&metadata[order]=signed&mode=payment&payment_method_types[0]=card&success_url=https%3A%2F%2Fexample.com%2Fsuccess",
    );
    const headers = new Headers(captured?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test_secret");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(headers.has("idempotency-key")).toBe(false);
  });

  test("reuses one idempotency key and body across an instant retry", async () => {
    const { client, requests, waits } = recordingCheckout(
      [
        new Response("busy", { status: 500 }),
        Response.json(stripeCheckoutSession()),
      ],
      2,
    );

    await client.checkout.sessions.create(checkoutParams());

    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(new Headers(requests[0]!.headers).get("idempotency-key")).toBe(
      new Headers(requests[1]!.headers).get("idempotency-key"),
    );
    expect(waits).toEqual([500]);
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
    let fetches = 0;
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        fetches += 1;
        return Promise.resolve(Response.json({ livemode: false }));
      },
    });

    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 0, external: 0, total: 0 }, () =>
          client.balance.retrieve(),
        ),
      ),
    ).rejects.toThrow("Blocked external operation: Stripe API request");
    expect(fetches).toBe(0);
  });

  test("reuses the POST body and idempotency key after a response body read failure", async () => {
    const { client, requests, waits } = recordingCheckout(
      [
        unreadableResponse(new TypeError("body disconnected")),
        Response.json(stripeCheckoutSession()),
      ],
      1,
    );

    await client.checkout.sessions.create(checkoutParams());

    const firstKey = new Headers(requests[0]!.headers).get("idempotency-key");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(firstKey).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(new Headers(requests[1]!.headers).get("idempotency-key")).toBe(
      firstKey,
    );
    expect(waits).toEqual([500]);
  });

  test("uses a different idempotency key for each POST operation", async () => {
    const keys: (string | null)[] = [];
    const client = createStripeClient("sk_test_secret", {
      fetch: (_input, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        return Promise.resolve(Response.json(stripeCheckoutSession()));
      },
      maxNetworkRetries: 1,
    });

    await Promise.all([
      client.checkout.sessions.create(checkoutParams()),
      client.checkout.sessions.create(checkoutParams()),
    ]);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(keys[1]).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("adds an idempotency key when exactly one retry is allowed", async () => {
    let key: string | null = null;
    const client = createStripeClient("sk_test_secret", {
      fetch: (_input, init) => {
        key = new Headers(init?.headers).get("idempotency-key");
        return Promise.resolve(Response.json(stripeCheckoutSession()));
      },
      maxNetworkRetries: 1,
    });
    await client.checkout.sessions.create(checkoutParams());
    expect(key).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
  });

  test("treats an empty-string override as no key", async () => {
    const { client, capturedKey } = refundHeaderProbe();
    await client.refunds.create({ amount: 1000, payment_intent: "pi_1" }, "");
    expect(capturedKey()).toBeNull();
  });
});
