import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { createStripeClient } from "#shared/stripe/client.ts";
import { unreadableResponse } from "#test/shared/stripe/request/fixtures.ts";

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

const expectInternalErrorPropagates = async (
  message: string,
  fetch: (internal: RangeError) => Promise<Response>,
): Promise<void> => {
  const internal = new RangeError(message);
  const { calls, client, waits } = failingBalance(() => fetch(internal), 2);
  const caught = await client.balance.retrieve().catch((error) => error);
  expect(caught).toBe(internal);
  expect(calls()).toBe(1);
  expect(waits).toEqual([]);
};

describe("Stripe transport errors", () => {
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
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      detail: {
        code: "resource_missing",
        provider: "stripe",
        requestId: "req_1",
        type: "invalid_request_error",
      },
      facts: { statusCode: 404 },
    });
    // Stripe's own wording rides on the message, where the sanitiser and the
    // checkout boundary already keep it from operators and buyers. None of
    // the closed fields may repeat it.
    expect(error.detail.code).not.toContain("Private value");
    expect(error.detail.type).not.toContain("Private value");
    expect(error.detail.requestId).not.toContain("Private value");
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
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { malformed: true, statusCode: 400 },
      message: "Invalid JSON received from the Stripe API",
    });
  });

  test("reports valid JSON with a malformed error shape as a protocol error", async () => {
    const error = await balanceErrorFrom(
      Response.json({ error: {} }, { status: 400 }),
    );
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { malformed: true, statusCode: 400 },
      message: "Invalid response received from the Stripe API",
    });
  });

  test("reports a connection failure after the configured retries", async () => {
    const { calls, client, waits } = failingBalance(
      () => Promise.reject(new TypeError("private network detail")),
      1,
    );
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error.facts).toEqual({ connectionReason: "network_error" });
    expect(calls()).toBe(2);
    expect(waits).toEqual([500]);
  });

  test("propagates an unexpected fetch implementation error", async () => {
    await expectInternalErrorPropagates(
      "broken request instrumentation",
      (internal) => Promise.reject(internal),
    );
  });

  test("reports the configured timeout without retrying", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () =>
        Promise.reject(new DOMException("timed out", "TimeoutError")),
      maxNetworkRetries: 0,
      timeout: 12,
    });
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toMatchObject({
      facts: { connectionReason: "timeout" },
      message: "Request aborted due to timeout being reached (12ms)",
    });
  });

  // Every provider aborts through `AbortSignal.timeout`, so an abort is a
  // timeout whatever name the runtime gives it. Stripe used to call a bare
  // abort a network failure while Square and SumUp called it a timeout.
  test("reports a transport abort as a timeout", async () => {
    const client = createStripeClient("sk_test_secret", {
      fetch: () => Promise.reject(new DOMException("aborted", "AbortError")),
      maxNetworkRetries: 0,
    });
    const error = await client.balance.retrieve().catch((caught) => caught);
    expect(error).toMatchObject({
      facts: { connectionReason: "timeout" },
      name: "ProviderTransportError",
    });
  });

  test("retries a timeout while reading the response body", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createStripeClient("sk_test_secret", {
      fetch: () => {
        calls++;
        if (calls > 1) {
          return Promise.resolve(Response.json({ livemode: false }));
        }
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
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).toMatchObject({
      facts: { connectionReason: "network_error" },
      message:
        "An error occurred with our connection to Stripe. Request was retried 2 times.",
    });
    expect(calls()).toBe(3);
    expect(waits).toEqual([500, 500]);
  });

  test("propagates an unexpected response body implementation error", async () => {
    await expectInternalErrorPropagates(
      "broken response instrumentation",
      (internal) => Promise.resolve(unreadableResponse(internal)),
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
    let requestInit: RequestInit | undefined;
    const client = createStripeClient("sk_test_secret", {
      fetch: (input, init) => {
        requested = String(input);
        requestInit = init;
        return Promise.resolve(
          Response.json({
            id: "pi_1",
            latest_charge: {
              amount_captured: 1000,
              amount_refunded: 0,
              captured: true,
              currency: "gbp",
              paid: true,
              status: "succeeded",
            },
          }),
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
