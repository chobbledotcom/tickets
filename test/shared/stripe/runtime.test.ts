import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
} from "#shared/stripe/client.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import {
  getStripeClient,
  resetStripeClient,
  retrieveCheckoutSession,
} from "#shared/stripe.ts";
import { stripeClient } from "#test/lib/stripe/fixtures.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withFetchMock, withMocks } from "#test-utils/mocks.ts";

describeStripe("Stripe client configuration", () => {
  const errors = setupErrorSpy();
  const balanceResponse = (): Promise<Response> =>
    Promise.resolve(
      Response.json({
        available: [],
        livemode: false,
        object: "balance",
        pending: [],
      }),
    );
  const requestBalanceAt = async (
    port: string | undefined,
  ): Promise<string> => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: "mock.local",
      STRIPE_MOCK_PORT: port,
    });
    resetStripeClient();
    let requestedUrl = "";
    await withFetchMock(async () => {
      globalThis.fetch = (input) => {
        requestedUrl = input.toString();
        return balanceResponse();
      };
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
    });
    resetStripeClient();
    return requestedUrl;
  };

  test("uses an edge-sized timeout and two network retries", () => {
    expect(STRIPE_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
  });

  test("uses the default stripe-mock port for requests", async () => {
    expect(await requestBalanceAt(undefined)).toBe(
      "http://mock.local:12111/v1/balance",
    );
  });

  test("reloads mock configuration when reset", async () => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: "mock.local",
      STRIPE_MOCK_PORT: "12111",
    });
    resetStripeClient();
    const urls: string[] = [];

    await withFetchMock(async () => {
      globalThis.fetch = (input) => {
        urls.push(input.toString());
        return balanceResponse();
      };
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
      Deno.env.set("STRIPE_MOCK_PORT", "13131");
      resetStripeClient();
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
    });

    expect(urls).toEqual([
      "http://mock.local:12111/v1/balance",
      "http://mock.local:13131/v1/balance",
    ]);
    resetStripeClient();
  });

  test("reset drops the cached client", async () => {
    await settings.update.stripe.secretKey("sk_test_123");
    const first = await getStripeClient();
    resetStripeClient();
    const second = await getStripeClient();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  test("parses the mock port as decimal", async () => {
    expect(await requestBalanceAt("0x10")).toBe(
      "http://mock.local:0/v1/balance",
    );
  });

  test("does not retry mock-server failures", async () => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: "mock.local",
      STRIPE_MOCK_PORT: "12111",
    });
    resetStripeClient();
    let attempts = 0;

    await withFetchMock(async () => {
      globalThis.fetch = () => {
        attempts++;
        return Promise.resolve(
          Response.json(
            { error: { message: "failed", type: "api_error" } },
            { status: 500 },
          ),
        );
      };
      await expect(
        stripeClientRuntime.create("sk_test_mock").balance.retrieve(),
      ).rejects.toThrow();
    });

    expect(attempts).toBe(1);
    resetStripeClient();
  });

  test("logs why no client can be created", async () => {
    setSuppressDebugLogs(false);
    const debugSpy = spy(console, "debug");
    try {
      expect(await getStripeClient()).toBeNull();
      expect(debugSpy.calls[0]?.args[0]).toContain(
        "No secret key configured, cannot create client",
      );
    } finally {
      debugSpy.restore();
      setSuppressDebugLogs(null);
    }
  });

  test("logs safe Stripe fields instead of the raw error message", async () => {
    const client = await stripeClient();
    const stripeError = Object.assign(
      new Error("Payment failed for private.person@example.com"),
      {
        code: "api_connection_error",
        requestId: "req_safe123",
        statusCode: 500,
        type: "StripeAPIError",
      },
    );

    await withMocks(
      () =>
        stub(client.checkout.sessions, "retrieve", () =>
          Promise.reject(stripeError),
        ),
      async () => {
        expect(await retrieveCheckoutSession("cs_test_123")).toBeNull();
      },
    );

    expect(errors.contains("status=500")).toBe(true);
    expect(errors.contains("code=api_connection_error")).toBe(true);
    expect(errors.contains("type=StripeAPIError")).toBe(true);
    expect(errors.contains("request=req_safe123")).toBe(true);
    expect(errors.contains("private.person@example.com")).toBe(false);
  });
});
