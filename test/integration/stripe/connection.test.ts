import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import { sanitizeStripeError } from "#shared/stripe/runtime.ts";
import {
  type StripeWebhookEvent,
  verifyWebhookSignature,
} from "#shared/stripe/webhook.ts";
import { detectStripeKeyMode, stripeApi } from "#shared/stripe.ts";
import {
  noWebhooks,
  okBalance,
  signedWebhook,
  stripeClient,
  withBalanceAndList,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";

describeStripe("stripe", () => {
  /** Stub `balance.retrieve` to fail with `error`, then run `body`. */
  const withFailingBalance = (
    client: Awaited<ReturnType<typeof stripeClient>>,
    error: unknown,
    body: () => void | Promise<void>,
  ) =>
    withMocks(
      () => stub(client.balance, "retrieve", () => Promise.reject(error)),
      body,
    );

  /** A failed connection whose API key check reports `error`. */
  const expectApiKeyError = (
    result: Awaited<ReturnType<typeof stripeApi.testStripeConnection>>,
    error: string,
  ) => {
    expect(result.ok).toBe(false);
    expect(result.apiKey.valid).toBe(false);
    expect(result.apiKey.error).toBe(error);
  };

  describe("testStripeConnection", () => {
    test("returns error when no API key configured", async () => {
      expectApiKeyError(
        await stripeApi.testStripeConnection(),
        "No Stripe secret key configured",
      );
    });

    test("returns error when balance.retrieve fails", async () => {
      const client = await stripeClient();
      await withFailingBalance(
        client,
        new Error("Invalid API Key provided"),
        async () => {
          expectApiKeyError(
            await stripeApi.testStripeConnection(),
            "Invalid API Key provided",
          );
        },
      );
    });

    test("returns test mode when API key is valid and no webhooks exist", async () => {
      const client = await stripeClient();
      await withBalanceAndList(
        client,
        okBalance(false),
        noWebhooks,
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("test");
          expect(result.webhooks).toHaveLength(0);
        },
      );
    });

    test("returns live mode for live key", async () => {
      const client = await stripeClient("sk_live_mock");
      await withBalanceAndList(
        client,
        okBalance(true),
        noWebhooks,
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("live");
        },
      );
    });

    test("reports success with one webhook", async () => {
      const client = await stripeClient();
      await activateStripe("whsec_only", "we_only");
      await withBalanceAndList(
        client,
        okBalance(false),
        () =>
          Promise.resolve({
            data: [
              {
                enabled_events: ["checkout.session.completed"],
                id: "we_only",
                object: "webhook_endpoint",
                status: "enabled",
                url: getPaymentWebhookUrl(),
              },
            ],
          }),
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(true);
          expect(result.webhooks).toHaveLength(1);
        },
      );
    });

    test("returns webhook error when list fails", async () => {
      const client = await stripeClient();
      await withBalanceAndList(
        client,
        okBalance(false),
        () => Promise.reject(new Error("Failed to list webhook endpoints")),
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.apiKey.valid).toBe(true);
          expect(result.webhookError).toContain(
            "Failed to list webhook endpoints",
          );
        },
      );
    });

    test("returns full success when API key valid and webhooks exist", async () => {
      const client = await stripeClient();
      await activateStripe("whsec_test", "we_test_valid");

      await withBalanceAndList(
        client,
        okBalance(false),
        () =>
          Promise.resolve({
            data: [
              {
                enabled_events: ["checkout.session.completed"],
                id: "we_test_valid",
                object: "webhook_endpoint",
                status: "enabled",
                url: getPaymentWebhookUrl(),
              },
              {
                enabled_events: ["payment_intent.succeeded"],
                id: "we_test_other",
                object: "webhook_endpoint",
                status: "enabled",
                url: "https://other.com/webhook",
              },
            ],
          }),
        async () => {
          const result = await stripeApi.testStripeConnection();
          expect(result.ok).toBe(true);
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("test");
          expect(result.ownEndpointId).toBe("we_test_valid");
          expect(result.webhooks).toHaveLength(2);
          const [first, second] = result.webhooks;
          expect(first!.endpointId).toBe("we_test_valid");
          expect(first!.url).toBe(getPaymentWebhookUrl());
          expect(first!.status).toBe("enabled");
          expect(first!.enabledEvents).toContain("checkout.session.completed");
          expect(second!.endpointId).toBe("we_test_other");
          expect(second!.url).toBe("https://other.com/webhook");
        },
      );
    });
  });

  describe("webhook signing", () => {
    test("creates valid payload and signature pair", async () => {
      const secret = "whsec_test_construction";
      const listing: StripeWebhookEvent = {
        data: {
          object: {
            amount: 1000,
            currency: "gbp",
          },
        },
        id: "evt_constructed",
        type: "payment_intent.succeeded",
      };

      const { payload, signature } = await signedWebhook(listing, secret);

      // Verify payload is valid JSON matching input
      const parsed = JSON.parse(payload);
      expect(parsed.id).toBe("evt_constructed");
      expect(parsed.type).toBe("payment_intent.succeeded");

      // Verify signature format
      expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]+$/);

      // Signature should be verifiable with the same secret (stored in DB)
      await activateStripe(secret, "we_test_construction");
      const result = await verifyWebhookSignature(payload, signature);
      expect(result.valid).toBe(true);
    });
  });

  describe("sanitizeStripeError", () => {
    test("returns 'unknown' for non-Error values", () => {
      expect(sanitizeStripeError("string error")).toBe("unknown");
      expect(sanitizeStripeError(null)).toBe("unknown");
      expect(sanitizeStripeError(42)).toBe("unknown");
      expect(sanitizeStripeError(undefined)).toBe("unknown");
    });

    test("returns error name for plain Error without Stripe fields", () => {
      expect(sanitizeStripeError(new Error("sensitive message"))).toBe("Error");
    });

    test("returns error name for typed errors without Stripe fields", () => {
      expect(sanitizeStripeError(new TypeError("bad type"))).toBe("TypeError");
    });

    test("extracts safe Stripe error fields", () => {
      const err = new Error("Invalid API Key provided: sk_test_****1234");
      Object.assign(err, {
        code: "api_key_invalid",
        requestId: "req_123",
        statusCode: 401,
        type: "StripeAuthenticationError",
      });
      expect(sanitizeStripeError(err)).toBe(
        "status=401 code=api_key_invalid type=StripeAuthenticationError request=req_123",
      );
    });

    test("extracts partial Stripe fields", () => {
      const err = new Error("Resource not found");
      Object.assign(err, { statusCode: 404 });
      expect(sanitizeStripeError(err)).toBe("status=404");
    });

    test("extracts code and type without statusCode", () => {
      const err = new Error("Connection failed");
      Object.assign(err, {
        code: "ECONNREFUSED",
        type: "StripeConnectionError",
      });
      expect(sanitizeStripeError(err)).toBe(
        "code=ECONNREFUSED type=StripeConnectionError",
      );
    });

    test("never includes the raw error message in output", () => {
      const sensitiveMessage = "Invalid API Key provided: sk_live_realkey123";
      const err = new Error(sensitiveMessage);
      Object.assign(err, {
        statusCode: 401,
        type: "StripeAuthenticationError",
      });
      const detail = sanitizeStripeError(err);
      expect(detail).not.toContain(sensitiveMessage);
      expect(detail).not.toContain("sk_live");
    });

    test("falls back to err.name when no Stripe fields present", () => {
      // Error with no statusCode/code/type but has a name
      const err = new Error("something");
      // Plain Error: err.name is "Error", parts is empty, so returns err.name || "Error"
      expect(sanitizeStripeError(err)).toBe("Error");
    });
  });

  describe("detectStripeKeyMode", () => {
    test("returns 'test' for sk_test_ keys", () => {
      expect(detectStripeKeyMode("sk_test_abc123")).toBe("test");
    });

    test("returns 'live' for sk_live_ keys", () => {
      expect(detectStripeKeyMode("sk_live_abc123")).toBe("live");
    });

    test("returns null for invalid prefixes", () => {
      expect(detectStripeKeyMode("sk_invalid_abc")).toBeNull();
      expect(detectStripeKeyMode("rk_test_abc")).toBeNull();
      expect(detectStripeKeyMode("")).toBeNull();
      expect(detectStripeKeyMode("random_string")).toBeNull();
    });
  });
});
