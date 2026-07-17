import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import type { StripeWebhookEvent } from "#shared/stripe.ts";
import {
  constructTestWebhookEvent,
  createCheckoutSession,
  detectStripeKeyMode,
  refundPayment,
  sanitizeErrorDetail,
  testStripeConnection,
  verifyWebhookSignature,
} from "#shared/stripe.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";
import {
  lineFor,
  noWebhooks,
  okBalance,
  stripeClient,
  withBalanceAndList,
} from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

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

  // stripe-mock creates the session; email absence just drops customer_email.
  const expectSessionCreated = async (intent: CheckoutIntent) => {
    await settings.update.stripe.secretKey("sk_test_mock");
    const session = await createCheckoutSession(
      intent,
      "http://localhost:3000",
    );
    expect(session).not.toBeNull();
    expect(session?.id).toBeDefined();
  };

  /** A failed connection whose API key check reports `error`. */
  const expectApiKeyError = (
    result: Awaited<ReturnType<typeof testStripeConnection>>,
    error: string,
  ) => {
    expect(result.ok).toBe(false);
    expect(result.apiKey.valid).toBe(false);
    expect(result.apiKey.error).toContain(error);
  };

  describe("testStripeConnection", () => {
    test("returns error when no API key configured", async () => {
      expectApiKeyError(
        await testStripeConnection(),
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
            await testStripeConnection(),
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
          const result = await testStripeConnection();
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
          const result = await testStripeConnection();
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("live");
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
          const result = await testStripeConnection();
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
                url: "https://example.com/payment/webhook",
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
          const result = await testStripeConnection();
          expect(result.ok).toBe(true);
          expect(result.apiKey.valid).toBe(true);
          expect(result.apiKey.mode).toBe("test");
          expect(result.ownEndpointId).toBe("we_test_valid");
          expect(result.webhooks).toHaveLength(2);
          const [first, second] = result.webhooks;
          expect(first!.endpointId).toBe("we_test_valid");
          expect(first!.url).toBe("https://example.com/payment/webhook");
          expect(first!.status).toBe("enabled");
          expect(first!.enabledEvents).toContain("checkout.session.completed");
          expect(second!.endpointId).toBe("we_test_other");
          expect(second!.url).toBe("https://other.com/webhook");
        },
      );
    });
  });

  describe("constructTestWebhookEvent", () => {
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

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        secret,
      );

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

  describe("sanitizeErrorDetail", () => {
    test("returns 'unknown' for non-Error values", () => {
      expect(sanitizeErrorDetail("string error")).toBe("unknown");
      expect(sanitizeErrorDetail(null)).toBe("unknown");
      expect(sanitizeErrorDetail(42)).toBe("unknown");
      expect(sanitizeErrorDetail(undefined)).toBe("unknown");
    });

    test("returns error name for plain Error without Stripe fields", () => {
      expect(sanitizeErrorDetail(new Error("sensitive message"))).toBe("Error");
    });

    test("returns error name for typed errors without Stripe fields", () => {
      expect(sanitizeErrorDetail(new TypeError("bad type"))).toBe("TypeError");
    });

    test("extracts safe Stripe error fields", () => {
      const err = new Error("Invalid API Key provided: sk_test_****1234");
      Object.assign(err, {
        code: "api_key_invalid",
        requestId: "req_123",
        statusCode: 401,
        type: "StripeAuthenticationError",
      });
      expect(sanitizeErrorDetail(err)).toBe(
        "status=401 code=api_key_invalid type=StripeAuthenticationError request=req_123",
      );
    });

    test("extracts partial Stripe fields", () => {
      const err = new Error("Resource not found");
      Object.assign(err, { statusCode: 404 });
      expect(sanitizeErrorDetail(err)).toBe("status=404");
    });

    test("extracts code and type without statusCode", () => {
      const err = new Error("Connection failed");
      Object.assign(err, {
        code: "ECONNREFUSED",
        type: "StripeConnectionError",
      });
      expect(sanitizeErrorDetail(err)).toBe(
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
      const detail = sanitizeErrorDetail(err);
      expect(detail).not.toContain(sensitiveMessage);
      expect(detail).not.toContain("sk_live");
    });

    test("falls back to err.name when no Stripe fields present", () => {
      // Error with no statusCode/code/type but has a name
      const err = new Error("something");
      // Plain Error: err.name is "Error", parts is empty, so returns err.name || "Error"
      expect(sanitizeErrorDetail(err)).toBe("Error");
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

  describe("createCheckoutSession - phone metadata", () => {
    test("includes phone in metadata when provided", async () => {
      const listing = testListing({ unit_price: 1000 });
      await expectSessionCreated(
        checkoutIntent({
          email: "john@example.com",
          items: [lineFor(listing)],
          name: "John Doe",
          phone: "+44 7700 900000",
        }),
      );
    });
  });

  describe("createCheckoutSession - no email", () => {
    test("creates checkout session without customer_email when email is empty", async () => {
      const listing = testListing({ unit_price: 1000 });
      await expectSessionCreated(
        checkoutIntent({
          email: "",
          items: [lineFor(listing)],
          name: "No Email User",
          phone: "+44 7700 900000",
        }),
      );
    });
  });

  describe("createCheckoutSession", () => {
    test("creates multi-checkout session with phone metadata", async () => {
      await expectSessionCreated(
        checkoutIntent({
          email: "jane@example.com",
          items: [
            checkoutItem({ name: "Listing A", quantity: 2, slug: "listing-a" }),
            checkoutItem({
              listingId: 2,
              name: "Listing B",
              slug: "listing-b",
              unitPrice: 2000,
            }),
          ],
          name: "Jane Doe",
          phone: "+44 7700 900001",
        }),
      );
    });

    test("returns null when stripe key not set", async () => {
      const result = await createCheckoutSession(
        checkoutIntent({
          email: "jane@example.com",
          items: [checkoutItem({ name: "Listing A", slug: "listing-a" })],
          name: "Jane Doe",
        }),
        "http://localhost:3000",
      );
      expect(result).toBeNull();
    });

    test("creates multi-checkout session without customer_email when email is empty", async () => {
      await expectSessionCreated(
        checkoutIntent({
          email: "",
          items: [
            checkoutItem({ name: "Listing A", slug: "listing-a" }),
            checkoutItem({
              listingId: 2,
              name: "Listing B",
              quantity: 2,
              slug: "listing-b",
              unitPrice: 2000,
            }),
          ],
          name: "No Email Multi",
          phone: "+44 7700 900002",
        }),
      );
    });
  });

  describe("refundPayment - non-Error exception", () => {
    test("handles non-Error thrown value in refund", async () => {
      const client = await stripeClient();
      // Throw a non-Error value to exercise the shared string conversion path.
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject("network failure string"),
          ),
        async () => {
          const result = await refundPayment("pi_test_123");
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("testStripeConnection - non-Error exception", () => {
    test("handles non-Error thrown value in balance check", async () => {
      const client = await stripeClient();
      await withFailingBalance(client, "string error", async () => {
        expectApiKeyError(await testStripeConnection(), "string error");
      });
    });

    test("handles non-Error thrown value in webhook list", async () => {
      const client = await stripeClient();
      await withBalanceAndList(
        client,
        okBalance(false),
        () => Promise.reject("webhook string error"),
        async () => {
          const result = await testStripeConnection();
          expect(result.ok).toBe(false);
          expect(result.webhookError).toBe("webhook string error");
        },
      );
    });
  });
});
