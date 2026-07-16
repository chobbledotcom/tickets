import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  getStripeClient,
  resetStripeClient,
  retrieveCheckoutSession,
} from "#shared/stripe.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { stripeClient } from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

describeStripe("Stripe client configuration", () => {
  const errors = setupErrorSpy();

  test("uses an edge-sized timeout and two network retries", async () => {
    using _env = withEnv({
      STRIPE_MOCK_HOST: undefined,
      STRIPE_MOCK_PORT: undefined,
    });
    resetStripeClient();
    await settings.update.stripe.secretKey("sk_test_123");
    const client = await getStripeClient();
    const inspectable = client as unknown as {
      getApiField: (name: string) => unknown;
      getMaxNetworkRetries: () => number;
    };

    expect(inspectable.getApiField("timeout")).toBe(20_000);
    expect(inspectable.getMaxNetworkRetries()).toBe(2);
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
