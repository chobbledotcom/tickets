import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { createStripeClient } from "#shared/stripe/client.ts";

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

describe("Stripe response retries", () => {
  test("does not retry when Stripe forbids it", async () => {
    const { calls, client } = oneCallErrorClient(
      Response.json(
        { error: { message: "No", type: "api_error" } },
        { headers: { "stripe-should-retry": "false" }, status: 500 },
      ),
    );

    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      ProviderTransportError,
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
        ProviderTransportError,
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
    await expectLockTimeoutRetry({
      code: "lock_timeout",
      type: "invalid_request_error",
    });
  });

  test("retries a 429 whose error type is lock_timeout", async () => {
    await expectLockTimeoutRetry({ type: "lock_timeout" });
  });

  test("does not retry a 429 rate-limit without lock_timeout", async () => {
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
      ProviderTransportError,
    );
    expect(waits).toEqual([]);
  });

  test("does not retry a 429 whose body cannot be parsed as JSON", async () => {
    const { client, waits } = retryingBalance(
      new Response("not json", { status: 429 }),
    );
    await expect(client.balance.retrieve()).rejects.toBeInstanceOf(
      ProviderTransportError,
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
});
