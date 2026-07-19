import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
} from "#shared/stripe/client.ts";
import { retrieveCheckoutSession } from "#shared/stripe.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { stripeClient } from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

describeStripe("Stripe client configuration", () => {
  const errors = setupErrorSpy();

  test("uses an edge-sized timeout and two network retries", () => {
    expect(STRIPE_TIMEOUT_MS).toBe(20_000);
    expect(STRIPE_MAX_NETWORK_RETRIES).toBe(2);
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
