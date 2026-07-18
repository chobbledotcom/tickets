import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { resetStripeClient, retrieveCheckoutSession } from "#shared/stripe.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { stripeClient } from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

const stripeApiConfig = async (
  host: string | undefined,
  port: string | undefined,
) => {
  using _env = withEnv({
    STRIPE_MOCK_HOST: host,
    STRIPE_MOCK_PORT: port,
  });
  resetStripeClient();
  const client = await stripeClient("sk_test_123");
  return client as unknown as {
    getApiField: (name: string) => unknown;
    getMaxNetworkRetries: () => number;
  };
};

describeStripe("Stripe client configuration", () => {
  const errors = setupErrorSpy();

  test("uses an edge-sized timeout and two network retries", async () => {
    const inspectable = await stripeApiConfig(undefined, undefined);

    expect(inspectable.getApiField("timeout")).toBe(20_000);
    expect(inspectable.getMaxNetworkRetries()).toBe(2);
  });

  test("uses port 12111 when the mock port is absent", async () => {
    const inspectable = await stripeApiConfig("localhost", undefined);
    expect(inspectable.getApiField("port")).toBe(12111);
  });

  test("parses the mock port as decimal", async () => {
    const inspectable = await stripeApiConfig("localhost", "0x2f4f");
    expect(inspectable.getApiField("port")).toBe("443");
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
