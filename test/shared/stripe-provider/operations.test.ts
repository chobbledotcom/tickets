import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { PaymentRefundResult } from "#shared/payments.ts";
import { sanitizeStripeError } from "#shared/stripe/runtime.ts";
import type { StripeWebhookEvent } from "#shared/stripe/webhook.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  signedWebhook,
  stripeCheckoutSession,
  stripeClient,
} from "#test/lib/stripe/fixtures.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { withEnv } from "#test-utils/env.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";
import { checkoutSessionEvent } from "#test-utils/webhooks.ts";

describeStripe("stripe-provider", () => {
  describe("verifyWebhookSignature delegation", () => {
    test("delegates to Stripe webhook verification", async () => {
      const TEST_SECRET = "whsec_provider_verify_test";
      await activateStripe(TEST_SECRET, "we_provider_test");

      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_provider",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await signedWebhook(listing, TEST_SECRET);

      const result = await stripePaymentProvider.verifyWebhookSignature(
        payload,
        signature,
        "https://example.com/payment/webhook",
        new TextEncoder().encode(payload),
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.listing.id).toBe("evt_provider");
      }
    });

    test("returns error for invalid signature", async () => {
      const TEST_SECRET = "whsec_provider_invalid_test";
      await activateStripe(TEST_SECRET, "we_provider_inv");

      const timestamp = Math.floor(Date.now() / 1000);
      const body = '{"test": true}';
      const result = await stripePaymentProvider.verifyWebhookSignature(
        body,
        `t=${timestamp},v1=invalid_sig`,
        "https://example.com/payment/webhook",
        new TextEncoder().encode(body),
      );

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("Signature verification failed");
      }
    });
  });

  describe("setupWebhookEndpoint delegation", () => {
    test("delegates to stripe.ts setupWebhookEndpoint", async () => {
      // Mock stripeApi since setupWebhookEndpointImpl creates its own client
      using _mockSetup = stub(stripeApi, "setupWebhookEndpoint", () =>
        Promise.resolve({
          endpointId: "we_provider_created",
          secret: "whsec_provider_secret",
          success: true,
        }),
      );
      const result = await stripePaymentProvider.setupWebhookEndpoint(
        "sk_test_mock",
        "https://example.com/payment/webhook",
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.endpointId).toBe("we_provider_created");
        expect(result.secret).toBe("whsec_provider_secret");
      }
    });
  });

  describe("refundPayment delegation", () => {
    for (const [status, outcome] of [
      ["succeeded", "refunded"],
      ["pending", "pending"],
      ["requires_action", "pending"],
      ["failed", "failed"],
      ["canceled", "failed"],
    ] as const) {
      test(`returns ${outcome} when Stripe reports ${status}`, async () => {
        const client = await stripeClient();
        await withMocks(
          () =>
            stub(client.refunds, "create", () =>
              Promise.resolve({ id: `re_${status}`, status }),
            ),
          async () => {
            expect(
              await stripePaymentProvider.refundPayment(`pi_${status}`),
            ).toBe(outcome);
          },
        );
      });
    }

    test("returns failed when Stripe returns null", async () => {
      await withMocks(
        () => stub(stripeApi, "refundPayment", () => Promise.resolve(null)),
        async () => {
          const result = await stripePaymentProvider.refundPayment("pi_null");
          expect(result).toBe("failed");
        },
      );
    });

    test("returns failed when refund fails", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject(new Error("Refund failed")),
          ),
        async () => {
          const result = await stripePaymentProvider.refundPayment("pi_fail");
          expect(result).toBe("failed");
        },
      );
    });

    test("uses one stable idempotency key for refund retries", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.resolve({ id: "re_retry", status: "pending" }),
          ),
        async (create) => {
          await stripePaymentProvider.refundPayment("pi_retry");
          await stripePaymentProvider.refundPayment("pi_retry");
          const keys = create.calls.map((call) => call.args[1]);
          expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(keys[1]).toBe(keys[0]);
        },
      );
    });
  });

  describe("sanitizeStripeError edge cases", () => {
    test("returns err.name when no statusCode/code/type and name is set", () => {
      const err = new TypeError("something went wrong");
      const detail = sanitizeStripeError(err);
      expect(detail).toBe("TypeError");
    });
  });

  describe("getMockConfig without STRIPE_MOCK_HOST", () => {
    test("creates client without mock config when STRIPE_MOCK_HOST not set", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      using _env = withEnv({
        STRIPE_MOCK_HOST: undefined,
        STRIPE_MOCK_PORT: undefined,
      });
      const client = await stripeClient("sk_test_123");
      expect(client.balance.retrieve).toBeInstanceOf(Function);
    });
  });

  describe("retrievePaymentIntent", () => {
    test("returns null when stripe key not set", async () => {
      const result = await stripeApi.retrievePaymentIntent("pi_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (retrieveSpy) => {
          const result = await stripeApi.retrievePaymentIntent("pi_test_123");
          expect(result).toBeNull();
          expect(retrieveSpy.calls[0]?.args).toEqual(["pi_test_123"]);
        },
      );
    });
  });

  describe("inspectPaymentRefund", () => {
    /** Refund inspection should return `expected` for the given intent lookup. */
    const expectRefunded = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      retrieveImpl: Awaited<
        ReturnType<typeof stripeClient>
      >["paymentIntents"]["retrieveWithLatestCharge"],
      expected: PaymentRefundResult,
    ) =>
      withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", retrieveImpl),
        async () => {
          const result =
            await stripePaymentProvider.inspectPaymentRefund("pi_check");
          expect(result).toBe(expected);
        },
      );

    test("returns refunded when latest_charge is refunded", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () =>
          Promise.resolve({
            id: "pi_refunded",
            latest_charge: { refunded: true },
          }),
        "refunded",
      );
    });

    test("returns failed when latest_charge is not refunded", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () =>
          Promise.resolve({
            id: "pi_not_refunded",
            latest_charge: { refunded: false },
          }),
        "failed",
      );
    });

    test("returns failed when payment intent not found", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () => Promise.reject(new Error("Not found")),
        "failed",
      );
    });
  });

  describe("createCheckoutSession - via provider", () => {
    test("returns null when session has no URL", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.checkout.sessions, "create", () =>
            Promise.resolve(
              stripeCheckoutSession({
                id: "cs_multi_nourl",
                url: null,
              }),
            ),
          ),
        async () => {
          const result = await stripePaymentProvider.createCheckoutSession(
            checkoutIntent({ email: "jane@example.com", name: "Jane" }),
            "http://localhost:3000",
          );
          expect(result).toBeNull();
        },
      );
    });
  });

  describe("metadata size limits", () => {
    test("returns error when items metadata exceeds Stripe limit", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");
      // Generate enough items to exceed 500-char serialized metadata
      const items = Array.from({ length: 40 }, (_, i) =>
        checkoutItem({
          listingId: i + 1,
          name: `Listing ${i + 1}`,
          slug: `listing-${i + 1}`,
        }),
      );
      const result = await stripePaymentProvider.createCheckoutSession(
        checkoutIntent({ email: "alice@example.com", items, name: "Alice" }),
        "http://localhost:3000",
      );
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(/too many listings/i);
    });

    test("returns null for non-PaymentUserError exceptions", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");
      // Stub stripeApi.createCheckoutSession to throw a generic error
      // that propagates through to withUserError's catch
      using _mockCreate = stub(stripeApi, "createCheckoutSession", () =>
        Promise.reject(new TypeError("unexpected")),
      );
      const result = await stripePaymentProvider.createCheckoutSession(
        checkoutIntent({ email: "john@example.com", name: "John" }),
        "http://localhost:3000",
      );
      expect(result).toBeNull();
    });
  });

  describe("resolveWebhookSession", () => {
    test("extracts session directly from listing with complete metadata", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession(
        checkoutSessionEvent({
          amountTotal: 2000,
          eventId: "evt_resolve_1",
          metadata: {
            email: "alice@example.com",
            items: '[{"e":1,"q":1,"p":0}]',
            name: "Alice",
          },
          paymentIntent: "pi_resolve_1",
          sessionId: "cs_resolve_1",
        }),
      );
      expect(result).not.toBe("skip");
      expect(result).not.toBeNull();
      if (result && result !== "skip" && result !== "retry") {
        expect(result.id).toBe("cs_resolve_1");
        expect(result.paymentStatus).toBe("paid");
        expect(result.paymentReference).toBe("pi_resolve_1");
        expect(result.amountTotal).toBe(2000);
      }
    });

    test("falls back to retrieveSession when listing lacks metadata", async () => {
      const mockRetrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(null),
      );

      try {
        const result = await stripePaymentProvider.resolveWebhookSession(
          checkoutSessionEvent({
            amountTotal: 0,
            eventId: "evt_no_meta",
            metadata: {},
            paymentIntent: "pi_no_meta",
            sessionId: "cs_no_meta",
          }),
        );
        // retrieveSession called with listing object id
        expect(mockRetrieve.calls[0]!.args[0]).toBe("cs_no_meta");
        expect(result).toBeNull();
      } finally {
        mockRetrieve.restore();
      }
    });

    test("returns null when listing has no id", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            some_field: "value",
          },
        },
        id: "evt_no_obj_id",
        type: "checkout.session.completed",
      });
      expect(result).toBeNull();
    });
  });
});
