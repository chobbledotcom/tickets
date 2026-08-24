import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { STRIPE_MAX_NETWORK_RETRIES } from "#shared/stripe/request.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { stripeApi } from "#shared/stripe.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withFetchMock, withMocks } from "#test-utils/mocks.ts";
import { stripeClient } from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

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
    let requestedUrl = "";
    await withFetchMock(async () => {
      globalThis.fetch = (input) => {
        requestedUrl = input.toString();
        return balanceResponse();
      };
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
    });
    return requestedUrl;
  };

  test("uses an edge-sized timeout and two network retries", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
  });

  test("uses the default stripe-mock port for requests", async () => {
    expect(await requestBalanceAt(undefined)).toBe(
      "http://mock.local:12111/v1/balance",
    );
  });

  test("reads changed mock configuration for each client", async () => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: "mock.local",
      STRIPE_MOCK_PORT: "12111",
    });
    const urls: string[] = [];

    await withFetchMock(async () => {
      globalThis.fetch = (input) => {
        urls.push(input.toString());
        return balanceResponse();
      };
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
      Deno.env.set("STRIPE_MOCK_PORT", "13131");
      await stripeClientRuntime.create("sk_test_mock").balance.retrieve();
    });

    expect(urls).toEqual([
      "http://mock.local:12111/v1/balance",
      "http://mock.local:13131/v1/balance",
    ]);
  });

  test("replaces the cached client when the secret key changes", async () => {
    const authorizations: (string | null)[] = [];
    await withFetchMock(async () => {
      globalThis.fetch = (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return balanceResponse();
      };
      await settings.update.stripe.secretKey("sk_test_first");
      const first = await stripeClientRuntime.get();
      await first!.balance.retrieve();
      await settings.update.stripe.secretKey("sk_test_second");
      const second = await stripeClientRuntime.get();
      await second!.balance.retrieve();
      expect(second).not.toBe(first);
    });
    expect(authorizations).toEqual([
      "Bearer sk_test_first",
      "Bearer sk_test_second",
    ]);
  });

  test("rejects a malformed mock port", async () => {
    await expect(requestBalanceAt("0x10")).rejects.toThrow(
      "STRIPE_MOCK_PORT must be a number from 1 to 65535",
    );
  });

  test("propagates malformed Stripe responses", async () => {
    await settings.update.stripe.secretKey("sk_test_123");
    await withFetchMock(async () => {
      globalThis.fetch = () => Promise.resolve(Response.json({ id: "cs_bad" }));
      await expect(
        stripeApi.retrieveCheckoutSession("cs_bad"),
      ).rejects.toThrow();
    });
  });

  test("does not retry mock-server failures", async () => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: "mock.local",
      STRIPE_MOCK_PORT: "12111",
    });
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
  });

  test("logs why no client can be created", async () => {
    setSuppressDebugLogs(false);
    const debugSpy = spy(console, "debug");
    try {
      expect(await stripeClientRuntime.get()).toBeNull();
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
    // Stripe's own wording lands on the message, so the sanitiser must read
    // the closed fields beside it and never the message itself.
    const stripeError = transportError.answered(
      providerDetail.stripe({
        code: "api_connection_error",
        requestId: "req_safe123",
        type: "StripeAPIError",
      }),
      500,
      "Payment failed for private.person@example.com",
    );

    await withMocks(
      () =>
        stub(client.checkout.sessions, "retrieve", () =>
          Promise.reject(stripeError),
        ),
      async () => {
        await expect(
          stripeApi.retrieveCheckoutSession("cs_test_123"),
        ).rejects.toThrow(
          "Stripe checkout could not be read (unavailable:provider_error)",
        );
      },
    );

    expect(errors.contains("status=500")).toBe(true);
    expect(errors.contains("code=api_connection_error")).toBe(true);
    expect(errors.contains("type=StripeAPIError")).toBe(true);
    expect(errors.contains("request=req_safe123")).toBe(true);
    expect(errors.contains("private.person@example.com")).toBe(false);
  });
});
