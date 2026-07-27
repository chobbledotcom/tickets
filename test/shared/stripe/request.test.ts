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
  StripeApiError,
  StripeConnectionError,
  StripeProtocolError,
} from "#shared/stripe/request.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { refundHeaderProbe } from "#test/shared/stripe/refund-header-probe.ts";
import {
  stripeCheckoutSession,
  stripePaymentIntent,
} from "#test/test-utils/stripe/fixtures.ts";

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

const expectLockTimeoutRetry = async (
  error: Record<string, string>,
): Promise<void> => {
  const { client, waits } = retryingBalance(
    Response.json({ error: { ...error, message: "Locked" } }, { status: 429 }),
  );
  expect(await client.balance.retrieve()).toEqual({ livemode: false });
  expect(waits).toEqual([500]);
};

const unreadableResponse = (error: unknown, status = 200): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    { status },
  );

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

const oneCallErrorClient = (response: Response) => {
  let calls = 0;
  const client = createStripeClient("sk_test_secret", {
    fetch: () => {
      calls += 1;
      return Promise.resolve(response);
    },
    sleep: () => Promise.reject(new Error("must not wait")),
  });
  return { calls: () => calls, client };
};

const balanceErrorFrom = async (response: Response): Promise<unknown> => {
  const client = createStripeClient("sk_test_secret", {
    fetch: () => Promise.resolve(response),
    maxNetworkRetries: 0,
  });
  return await client.balance.retrieve().catch((caught) => caught);
};

const failingBalance = (
  fetch: () => Promise<Response>,
  maxNetworkRetries: number,
) => {
  let calls = 0;
  const waits: number[] = [];
  const client = createStripeClient("sk_test_secret", {
    fetch: () => {
      calls += 1;
      return fetch();
    },
    maxNetworkRetries,
    random: () => 0,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { calls: () => calls, client, waits };
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

  test("treats an empty-string override as no key, not as the retry default", async () => {
    // An explicitly-empty idempotency key must NOT be swallowed into the
    // random retry default: nullish coalescing (??) only falls through on
    // null/undefined, while logical-or (||) would replace "" with the retry
    // key. Real callers pass a 43-char SHA-256 key or undefined, but locking
    // this keeps the ?? intent explicit.
    const { client, capturedKey } = refundHeaderProbe();

    await client.refunds.create({ payment_intent: "pi_1" }, "");

    expect(capturedKey()).toBeNull();
  });

  test("does not retry when Stripe forbids it", async () => {
    const { calls, client } = oneCallErrorClient(
      Response.json(
        { error: { message: "No", type: "api_error" } },
        { headers: { "stripe-should-retry": "false" }, status: 500 },
      ),
    );

    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      StripeApiError,
    );
    expect(calls()).toBe(1);
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

  test("accepts Retry-After at the 60 second boundary", async () => {
    const { client, waits } = retryingBalance(
      new Response("busy", {
        headers: { "retry-after": "60" },
        status: 500,
      }),
    );

    await client.balance.retrieve();
    expect(waits).toEqual([60_000]);
  });

  test("uses the default delay for unusable Retry-After values", async () => {
    const values = ["1.5", "invalid", "0", "-1"];
    const waits = await Promise.all(
      values.map(async (retryAfter) => {
        const retrying = retryingBalance(
          new Response("busy", {
            headers: { "retry-after": retryAfter },
            status: 500,
          }),
        );
        await retrying.client.balance.retrieve();
        return retrying.waits;
      }),
    );

    expect(waits).toEqual([[500], [500], [500], [500]]);
  });

  test("does not retry a default non-retry response with Retry-After", async () => {
    for (const status of [400, 499]) {
      const { calls, client } = oneCallErrorClient(
        Response.json(
          { error: { message: "No", type: "invalid_request_error" } },
          { headers: { "retry-after": "2" }, status },
        ),
      );
      await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
        StripeApiError,
      );
      expect(calls()).toBe(1);
    }
  });

  test("caps exponential retry delays", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls += 1;
        return Promise.resolve(
          calls <= 7
            ? new Response("busy", { status: 500 })
            : Response.json({ livemode: false }),
        );
      },
      maxNetworkRetries: 7,
      random: () => 0.5,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });

    await client.balance.retrieve();
    expect(waits).toEqual([500, 500, 750, 1500, 3000, 5000, 5000]);
  });

  test("retries conflicts", async () => {
    const { client, waits } = retryingBalance(
      new Response("conflict", { status: 409 }),
    );
    expect(await client.balance.retrieve()).toEqual({ livemode: false });
    expect(waits).toEqual([500]);
  });

  test("retries a 429 whose error code is lock_timeout", async () => {
    // Stripe returns 429 with `error.code === "lock_timeout"` when two
    // concurrent requests contend on the same resource. Stripe's docs and
    // SDK treat these as retryable, so the transport must use the configured
    // retry budget — replacing stripe-node must not turn a retryable refund
    // or PaymentIntent lookup into an immediate failure.
    await expectLockTimeoutRetry({
      code: "lock_timeout",
      type: "invalid_request_error",
    });
  });

  test("retries a 429 whose error type is lock_timeout", async () => {
    await expectLockTimeoutRetry({ type: "lock_timeout" });
  });

  test("does not retry a 429 rate-limit without lock_timeout", async () => {
    // A vanilla 429 rate-limit is only retryable when Stripe asks for it via
    // `stripe-should-retry: true`; without that header the transport surfaces
    // the rate-limit immediately rather than compounding it with retries.
    const { client, waits } = retryingBalance(
      Response.json(
        {
          error: {
            code: "rate_limit",
            message: "Slow down",
            type: "rate_limit_error",
          },
        },
        { status: 429 },
      ),
    );
    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      StripeApiError,
    );
    expect(waits).toEqual([]);
  });

  test("does not retry a 429 whose body cannot be parsed as JSON", async () => {
    // If the 429 body is not valid JSON, the lock_timeout check fails and
    // falls through to the error path: the response is surfaced as a
    // StripeProtocolError (Invalid JSON) without a retry.
    const { client, waits } = retryingBalance(
      new Response("not json", { status: 429 }),
    );
    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      StripeProtocolError,
    );
    expect(waits).toEqual([]);
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

  test("retries when cancelling the response body rejects", async () => {
    const body = new ReadableStream({
      cancel: () => Promise.reject(new TypeError("cancel failed")),
    });
    const { client, waits } = retryingBalance(
      new Response(body, { status: 500 }),
    );

    expect(await client.balance.retrieve()).toEqual({ livemode: false });
    expect(waits).toEqual([500]);
  });

  test("returns structured error fields from a non-ok response", async () => {
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
    // Structured fields are the privacy-safe surface (sanitizeStripeError
    // reads these and never logs Stripe's raw message). The raw response's
    // error.code/type/request-id surface here verbatim. error.message is
    // the deliberate exception: it mirrors Stripe's error.message for
    // stripe-node parity, and the privacy protection lives one layer up
    // in sanitizeStripeError (runtime.ts:31), which never logs it.
    expect(error).toMatchObject({
      code: "resource_missing",
      requestId: "req_1",
      statusCode: 404,
      type: "invalid_request_error",
    });
    expect(error.name).toBe("StripeApiError");
    // The structured fields must not bleed Stripe's raw message into
    // themselves — they are the privacy-safe surface. error.message is
    // intentionally excluded from this invariant (see the comment above).
    expect(error.code).not.toContain("Private value");
    expect(error.type).not.toContain("Private value");
    expect(error.requestId).not.toContain("Private value");
  });

  test("fails loudly on invalid success JSON", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () => Promise.resolve(new Response("not json")),
      maxNetworkRetries: 0,
    });
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect((error as Error).message).toBe(
      "Invalid JSON received from the Stripe API",
    );
  });

  test("fails loudly on an invalid success shape", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () => Promise.resolve(Response.json({ livemode: "no" })),
      maxNetworkRetries: 0,
    });
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect((error as Error).message).toBe(
      "Invalid response received from the Stripe API",
    );
  });

  test("fails loudly on an invalid error response", async () => {
    const error = await balanceErrorFrom(
      new Response("not json", { status: 400 }),
    );
    expect(error).toBeInstanceOf(StripeProtocolError);
    expect(error).toMatchObject({
      message: "Invalid JSON received from the Stripe API",
      name: "StripeProtocolError",
    });
  });

  test("reports valid JSON with a malformed error shape as a protocol error", async () => {
    const error = await balanceErrorFrom(
      Response.json({ error: {} }, { status: 400 }),
    );
    expect(error).toBeInstanceOf(StripeProtocolError);
    expect((error as Error).message).toBe(
      "Invalid response received from the Stripe API",
    );
    expect((error as Error).name).toBe("StripeProtocolError");
  });

  test("reports a connection failure after the configured retries", async () => {
    const { calls, client, waits } = failingBalance(
      () => Promise.reject(new TypeError("private network detail")),
      1,
    );
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toBeInstanceOf(StripeConnectionError);
    expect(error.name).toBe("StripeConnectionError");
    expect(calls()).toBe(2);
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

  test("retries a timeout while reading the response body", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls++;
        if (calls > 1)
          return Promise.resolve(Response.json({ livemode: false }));
        return Promise.resolve(
          unreadableResponse(new DOMException("timed out", "TimeoutError")),
        );
      },
      maxNetworkRetries: 1,
      random: () => 0,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });

    expect(await client.balance.retrieve()).toEqual({ livemode: false });
    expect(calls).toBe(2);
    expect(waits).toEqual([500]);
  });

  test("reports the exact connection failure after response body retries end", async () => {
    const { calls, client, waits } = failingBalance(
      () =>
        Promise.resolve(
          unreadableResponse(new TypeError("private body detail")),
        ),
      2,
    );

    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toBeInstanceOf(StripeConnectionError);
    expect(error).toMatchObject({
      message:
        "An error occurred with our connection to Stripe. Request was retried 2 times.",
      name: "StripeConnectionError",
    });
    expect(calls()).toBe(3);
    expect(waits).toEqual([500, 500]);
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
    let requestInit: RequestInit | undefined;
    const client = createStripeClient("sk_test_secret", {
      fetch: (input, init) => {
        requested = String(input);
        requestInit = init;
        return Promise.resolve(
          Response.json(stripePaymentIntent({ id: "pi_1" })),
        );
      },
      maxNetworkRetries: 0,
    });
    await client.paymentIntents.retrieveWithLatestCharge("pi/unsafe");
    expect(requested).toBe(
      "https://api.stripe.com/v1/payment_intents/pi%2Funsafe?expand[0]=latest_charge",
    );
    expect(requestInit?.body).toBeUndefined();
  });
});
