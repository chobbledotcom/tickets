import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createStripeClient,
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  StripeApiError,
  StripeConnectionError,
} from "#shared/stripe/client.ts";

const checkout = () => ({
  amount_total: 1000,
  created: 123,
  id: "cs_1",
  metadata: {},
  payment_intent: "pi_1",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_1",
});

const retryingBalance = (firstResponse: Response) => {
  const waits: number[] = [];
  let first = true;
  const client = createStripeClient("sk_test_secret", {
    fetch: () => {
      const response = first
        ? firstResponse
        : Response.json({ livemode: false });
      first = false;
      return Promise.resolve(response);
    },
    random: () => 0,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { client, waits };
};

describe("Stripe client", () => {
  test("keeps the production timeout and retry limits explicit", () => {
    expect(STRIPE_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
  });

  test("sends versioned nested form requests with bearer authentication", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = createStripeClient("sk_test_secret", {
      fetch: (input, init = {}) => {
        captured = { init, url: String(input) };
        return Promise.resolve(Response.json(checkout()));
      },
      maxNetworkRetries: 0,
    });

    await client.checkout.sessions.create({
      line_items: [{ quantity: 2 }],
      mode: "payment",
    });

    expect(captured?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(captured?.init.method).toBe("POST");
    expect(captured?.init.body).toBe("line_items[0][quantity]=2&mode=payment");
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
    const requests: RequestInit[] = [];
    const waits: number[] = [];
    const responses = [
      new Response("busy", { status: 500 }),
      Response.json(checkout()),
    ];
    const client = createStripeClient("sk_test_secret", {
      fetch: (_input, init = {}) => {
        requests.push(init);
        return Promise.resolve(responses.shift()!);
      },
      maxNetworkRetries: 2,
      random: () => 0,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });

    await client.checkout.sessions.create({ mode: "payment" });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toBe(requests[1]!.body);
    expect(new Headers(requests[0]!.headers).get("idempotency-key")).toBe(
      new Headers(requests[1]!.headers).get("idempotency-key"),
    );
    expect(waits).toEqual([500]);
  });

  test("adds an idempotency key when exactly one retry is allowed", async () => {
    let key: string | null = null;
    const client = createStripeClient("sk_test_secret", {
      fetch: (_input, init) => {
        key = new Headers(init?.headers).get("idempotency-key");
        return Promise.resolve(Response.json(checkout()));
      },
      maxNetworkRetries: 1,
    });
    await client.checkout.sessions.create({ mode: "payment" });
    expect(key).toMatch(/^tickets-stripe-retry-[0-9a-f-]+$/);
  });

  test("does not retry when Stripe forbids it", async () => {
    let calls = 0;
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          Response.json(
            {
              error: { message: "No", type: "api_error" },
            },
            { headers: { "stripe-should-retry": "false" }, status: 500 },
          ),
        );
      },
      sleep: () => Promise.resolve(),
    });

    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      StripeApiError,
    );
    expect(calls).toBe(1);
  });

  test("uses Retry-After when Stripe requests a retry", async () => {
    const { client, waits } = retryingBalance(
      new Response("busy", {
        headers: { "retry-after": "2", "stripe-should-retry": "true" },
        status: 400,
      }),
    );

    expect(await client.balance.retrieve()).toEqual({ livemode: false });
    expect(waits).toEqual([2000]);
  });

  test("ignores an excessive Retry-After", async () => {
    const { client, waits } = retryingBalance(
      new Response("busy", {
        headers: { "retry-after": "61" },
        status: 500,
      }),
    );

    await client.balance.retrieve();
    expect(waits).toEqual([500]);
  });

  test("caps exponential retry delays", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          calls <= 5
            ? new Response("busy", { status: 500 })
            : Response.json({ livemode: false }),
        );
      },
      maxNetworkRetries: 5,
      random: () => 0.5,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });

    await client.balance.retrieve();
    expect(waits).toEqual([500, 750, 1500, 3000, 3750]);
  });

  test("retries conflicts", async () => {
    const { client, waits } = retryingBalance(
      new Response("conflict", { status: 409 }),
    );
    expect(await client.balance.retrieve()).toEqual({ livemode: false });
    expect(waits).toEqual([500]);
  });

  test("cancels a retry response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
    });
    const { client } = retryingBalance(new Response(body, { status: 500 }));
    await client.balance.retrieve();
    expect(cancelled).toBe(true);
  });

  test("returns structured error fields without exposing the response body", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "resource_missing",
                message: "Private value",
                type: "invalid_request_error",
              },
            },
            { headers: { "request-id": "req_1" }, status: 404 },
          ),
        ),
      maxNetworkRetries: 0,
    });

    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toBeInstanceOf(StripeApiError);
    expect(error).toMatchObject({
      code: "resource_missing",
      requestId: "req_1",
      statusCode: 404,
      type: "invalid_request_error",
    });
    expect(error.name).toBe("StripeApiError");
  });

  test("fails loudly on invalid success JSON", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () => Promise.resolve(new Response("not json")),
      maxNetworkRetries: 0,
    });
    await expect(client.balance.retrieve()).rejects.toThrow(
      "Invalid JSON received from the Stripe API",
    );
  });

  test("fails loudly on an invalid error response", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () => Promise.resolve(new Response("not json", { status: 400 })),
      maxNetworkRetries: 0,
    });
    await expect(client.balance.retrieve()).rejects.toMatchObject({
      message: "Invalid JSON received from the Stripe API",
      name: "StripeApiError",
      statusCode: 400,
      type: "StripeAPIError",
    });
  });

  test("reports a connection failure after the configured retries", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls += 1;
        return Promise.reject(new TypeError("private network detail"));
      },
      maxNetworkRetries: 1,
      random: () => 0,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toBeInstanceOf(StripeConnectionError);
    expect(error.name).toBe("StripeConnectionError");
    expect(calls).toBe(2);
    expect(waits).toEqual([500]);
  });

  test("reports the configured timeout without retrying", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () =>
        Promise.reject(new DOMException("timed out", "TimeoutError")),
      maxNetworkRetries: 0,
      timeout: 12,
    });
    await expect(client.balance.retrieve()).rejects.toThrow(
      "Request aborted due to timeout being reached (12ms)",
    );
  });

  test("accepts zero as an explicit timeout", async () => {
    let signal: AbortSignal | undefined;
    const client = createStripeClient("sk_test_secret", {
      fetch: (_input, init) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(Response.json({ livemode: false }));
      },
      maxNetworkRetries: 0,
      timeout: 0,
    });
    await client.balance.retrieve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signal?.aborted).toBe(true);
  });

  test("escapes resource IDs and encodes GET parameters", async () => {
    let requested = "";
    const client = createStripeClient("sk_test_secret", {
      fetch: (input) => {
        requested = String(input);
        return Promise.resolve(
          Response.json({
            id: "pi_1",
            latest_charge: { refunded: false },
          }),
        );
      },
      maxNetworkRetries: 0,
    });
    await client.paymentIntents.retrieve("pi/unsafe", {
      expand: ["latest_charge"],
    });
    expect(requested).toBe(
      "https://api.stripe.com/v1/payment_intents/pi%2Funsafe?expand[0]=latest_charge",
    );
  });
});
