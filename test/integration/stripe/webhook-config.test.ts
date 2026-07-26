import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import {
  newWebhookApiCalls,
  webhookEndpointsApi,
} from "#test/test-utils/stripe/webhook-mocks.ts";
import { withEnv } from "#test-utils/env.ts";

const withStripeClient = async (
  env: Record<string, string | undefined>,
  check: (client: Awaited<ReturnType<typeof stripeClientRuntime.get>>) => void,
): Promise<void> => {
  using _env = withEnv(env);
  await settings.update.stripe.secretKey("sk_test_123");
  check(await stripeClientRuntime.get());
};

describeStripe("Stripe webhook setup", () => {
  describe("client configuration", () => {
    test("creates a client without mock-server configuration", async () => {
      await withStripeClient(
        { STRIPE_MOCK_HOST: undefined, STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });

    test("uses the default mock-server port", async () => {
      await withStripeClient(
        { STRIPE_MOCK_HOST: "localhost", STRIPE_MOCK_PORT: undefined },
        (client) => expect(client).not.toBeNull(),
      );
    });
  });

  describe("mock helper", () => {
    test("returns null for non-webhook URLs", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      expect(await api("https://example.com/other", {})).toBeNull();
    });

    test("handles GET without init (defaults to GET method)", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api("https://api.stripe.com/v1/webhook_endpoints");
      const body = await response!.json();
      expect(body.data).toHaveLength(2);
    });

    test("records the created body on a successful POST", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api(
        "https://api.stripe.com/v1/webhook_endpoints",
        {
          body: "enabled_events[0]=checkout.session.completed&url=https://example.com/payment/webhook",
          method: "POST",
        },
      );
      const body = await response!.json();
      expect(body.id).toBe("we_new");
      expect(calls.createdBody).not.toBeNull();
      expect(calls.createdBody!.get("url")).toBe(
        "https://example.com/payment/webhook",
      );
    });

    test("handles POST without init body (defaults to empty string)", async () => {
      const calls = newWebhookApiCalls();
      const api = webhookEndpointsApi(
        "https://example.com/payment/webhook",
        calls,
      );
      const response = await api(
        "https://api.stripe.com/v1/webhook_endpoints",
        { method: "POST" },
      );
      const body = await response!.json();
      expect(body.id).toBe("we_new");
      expect(calls.createdBody).not.toBeNull();
    });
  });
});
