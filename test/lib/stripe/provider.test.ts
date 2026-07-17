import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { StripeWebhookEvent } from "#shared/stripe.ts";
import {
  constructTestWebhookEvent,
  resetStripeClient,
  retrievePaymentIntent,
  sanitizeErrorDetail,
  stripeApi,
} from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { activateStripe } from "#test-utils/settings.ts";
import { lineFor, stripeClient } from "./fixtures.ts";
import { describeStripe } from "./harness.ts";

describeStripe("stripe-provider", () => {
  /** Stub `checkout.sessions.retrieve` with `impl`, then run `body`. */
  const whileRetrieving = (
    client: Awaited<ReturnType<typeof stripeClient>>,
    impl: () => Promise<unknown>,
    body: () => void | Promise<void>,
  ) =>
    withMocks(
      () => stub(client.checkout.sessions, "retrieve", impl as never),
      body,
    );

  describe("toCheckoutResult - session with no URL", () => {
    /** The checkout should collapse to null when the SDK create behaves badly. */
    const expectNullCheckout = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      createImpl: () => Promise<unknown>,
    ) =>
      withMocks(
        () => stub(client.checkout.sessions, "create", createImpl as never),
        async () => {
          const listing = testListing({ unit_price: 1000 });
          const result = await stripePaymentProvider.createCheckoutSession(
            checkoutIntent({
              email: "john@example.com",
              items: [lineFor(listing)],
              name: "John",
            }),
            "http://localhost:3000",
          );
          expect(result).toBeNull();
        },
      );

    test("returns null when session has no URL", async () => {
      const client = await stripeClient();
      await expectNullCheckout(client, () =>
        Promise.resolve({
          id: "cs_no_url",
          object: "checkout.session",
          url: null,
        }),
      );
    });

    test("returns null when session is null", async () => {
      const client = await stripeClient();
      await expectNullCheckout(client, () =>
        Promise.reject(new Error("API error")),
      );
    });
  });

  describe("retrieveSession - edge cases", () => {
    test("returns null when a paid session has no payment intent", async () => {
      const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve({
          amount_total: 1000,
          created: 0,
          id: "cs_paid_without_intent",
          metadata: {
            email: "alice@example.com",
            items: '[{"e":1,"q":1,"p":0}]',
            name: "Alice",
          },
          payment_intent: null,
          payment_status: "paid",
          status: "complete",
        }),
      );
      try {
        expect(
          await stripePaymentProvider.retrieveSession("cs_paid_without_intent"),
        ).toBeNull();
      } finally {
        retrieve.restore();
      }
    });
    test("returns null for session without items", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            id: "cs_no_items",
            metadata: {
              email: "test@example.com",
              name: "Test User",
              // No items field
            },
            payment_intent: "pi_test_123",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_no_items");
          expect(result).toBeNull();
        },
      );
    });

    test("returns null when session is null from Stripe", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () => Promise.reject(new Error("Not found")),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_notfound");
          expect(result).toBeNull();
        },
      );
    });

    test("returns null when metadata is missing name or email", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            id: "cs_no_meta",
            metadata: {
              items: '[{"e":1,"q":1,"p":0}]',
              // Missing name and email
            },
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_no_meta");
          expect(result).toBeNull();
        },
      );
    });

    test("returns valid session for multi-ticket checkout", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            id: "cs_multi",
            metadata: {
              email: "multi@example.com",
              items: '[{"e":1,"q":2}]',
              name: "Multi User",
              phone: "+44 7700 900000",
            },
            payment_intent: "pi_multi_123",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_multi");
          expect(result).not.toBeNull();
          expect(result?.id).toBe("cs_multi");
          expect(result?.metadata.items).toBe('[{"e":1,"q":2}]');
          expect(result?.metadata.phone).toBe("+44 7700 900000");
        },
      );
    });

    test("returns valid session for single-listing checkout", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            id: "cs_single",
            metadata: {
              email: "single@example.com",
              items: '[{"e":42,"q":2,"p":0}]',
              name: "Single User",
            },
            payment_intent: "pi_single_123",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_single");
          expect(result).not.toBeNull();
          expect(result?.id).toBe("cs_single");
          expect(result?.paymentStatus).toBe("paid");
          expect(result?.paymentReference).toBe("pi_single_123");
          expect(result?.metadata.items).toBe('[{"e":42,"q":2,"p":0}]');
        },
      );
    });

    test("returns amountTotal when session has numeric amount_total", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            amount_total: 4500,
            id: "cs_with_amount",
            metadata: {
              email: "amount@example.com",
              items: '[{"e":10,"q":3,"p":0}]',
              name: "Amount User",
            },
            payment_intent: "pi_amount_123",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_with_amount");
          expect(result).not.toBeNull();
          expect(result?.amountTotal).toBe(4500);
          expect(result?.paymentReference).toBe("pi_amount_123");
        },
      );
    });

    test("returns null when amount_total is null", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            amount_total: null,
            id: "cs_null_amount",
            metadata: {
              email: "nullamount@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Null Amount User",
            },
            payment_intent: "pi_null_amount",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_null_amount");
          expect(result).toBeNull();
        },
      );
    });

    test("falls back to unpaid for invalid payment_status", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            amount_total: 1000,
            id: "cs_bad_status",
            metadata: {
              email: "badstatus@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Bad Status User",
            },
            payment_intent: "pi_bad_status",
            payment_status: "completed",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_bad_status");
          expect(result).not.toBeNull();
          expect(result?.paymentStatus).toBe("unpaid");
        },
      );
    });

    test("casts amount_total to number", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve({
            amount_total: 7500,
            id: "cs_amount_cast",
            metadata: {
              email: "cast@example.com",
              items: '[{"e":11,"q":1,"p":0}]',
              name: "Cast User",
            },
            payment_intent: "pi_amount_cast",
            payment_status: "paid",
          }),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_amount_cast");
          expect(result).not.toBeNull();
          expect(result?.amountTotal).toBe(7500);
        },
      );
    });
  });

  describe("verifyWebhookSignature delegation", () => {
    test("delegates to stripe.ts verifyWebhookSignature", async () => {
      const TEST_SECRET = "whsec_provider_verify_test";
      await activateStripe(TEST_SECRET, "we_provider_test");

      const listing: StripeWebhookEvent = {
        data: { object: { id: "cs_test" } },
        id: "evt_provider",
        type: "checkout.session.completed",
      };

      const { payload, signature } = await constructTestWebhookEvent(
        listing,
        TEST_SECRET,
      );

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
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("setupWebhookEndpoint delegation", () => {
    test("delegates to stripe.ts setupWebhookEndpoint", async () => {
      // Mock stripeApi since setupWebhookEndpointImpl creates its own client
      const origSetup = stripeApi.setupWebhookEndpoint;
      stripeApi.setupWebhookEndpoint = (_key, _url, _existing) =>
        Promise.resolve({
          endpointId: "we_provider_created",
          secret: "whsec_provider_secret",
          success: true,
        });

      try {
        const result = await stripePaymentProvider.setupWebhookEndpoint(
          "sk_test_mock",
          "https://example.com/payment/webhook",
        );

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.endpointId).toBe("we_provider_created");
          expect(result.secret).toBe("whsec_provider_secret");
        }
      } finally {
        stripeApi.setupWebhookEndpoint = origSetup;
      }
    });
  });

  describe("refundPayment delegation", () => {
    for (const [status, completed] of [
      ["succeeded", true],
      ["pending", false],
      ["requires_action", false],
      ["failed", false],
      ["canceled", false],
    ] as const) {
      test(`returns ${completed} when Stripe reports ${status}`, async () => {
        const client = await stripeClient();
        await withMocks(
          () =>
            stub(client.refunds, "create", () =>
              Promise.resolve({ id: `re_${status}`, status } as never),
            ),
          async () => {
            expect(
              await stripePaymentProvider.refundPayment(`pi_${status}`),
            ).toBe(completed);
          },
        );
      });
    }

    test("returns false when Stripe returns null (no refund created)", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () => Promise.resolve(null as never)),
        async () => {
          const result = await stripePaymentProvider.refundPayment("pi_null");
          expect(result).toBe(false);
        },
      );
    });

    test("returns false when refund fails", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject(new Error("Refund failed")),
          ),
        async () => {
          const result = await stripePaymentProvider.refundPayment("pi_fail");
          expect(result).toBe(false);
        },
      );
    });
  });

  describe("sanitizeErrorDetail edge cases", () => {
    test("returns err.name when no statusCode/code/type and name is set", () => {
      const err = new TypeError("something went wrong");
      const detail = sanitizeErrorDetail(err);
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
      try {
        // resetStripeClient now also resets getMockConfig (lazyRef)
        resetStripeClient();

        const client = await stripeClient("sk_test_123");
        // Client is created using real Stripe (no mock) - returns non-null
        expect(client !== undefined).toBe(true);
      } finally {
        resetStripeClient();
      }
    });
  });

  describe("retrievePaymentIntent", () => {
    test("returns null when stripe key not set", async () => {
      const result = await retrievePaymentIntent("pi_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieve", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (retrieveSpy) => {
          const result = await retrievePaymentIntent("pi_test_123");
          expect(result).toBeNull();
          expect(retrieveSpy.calls.length).toBeGreaterThan(0);
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    /** isPaymentRefunded should return `expected` for the given intent lookup. */
    const expectRefunded = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      retrieveImpl: () => Promise<unknown>,
      expected: boolean,
    ) =>
      withMocks(
        () => stub(client.paymentIntents, "retrieve", retrieveImpl as never),
        async () => {
          const result =
            await stripePaymentProvider.isPaymentRefunded("pi_check");
          expect(result).toBe(expected);
        },
      );

    test("returns true when latest_charge is refunded", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () =>
          Promise.resolve({
            id: "pi_refunded",
            latest_charge: { id: "ch_1", refunded: true },
          }),
        true,
      );
    });

    test("returns false when latest_charge is not refunded", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () =>
          Promise.resolve({
            id: "pi_not_refunded",
            latest_charge: { id: "ch_2", refunded: false },
          }),
        false,
      );
    });

    test("returns false when payment intent not found", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () => Promise.reject(new Error("Not found")),
        false,
      );
    });

    test("returns false when latest_charge is a string ID", async () => {
      const client = await stripeClient();
      await expectRefunded(
        client,
        () =>
          Promise.resolve({
            id: "pi_string_charge",
            latest_charge: "ch_string_id",
          }),
        false,
      );
    });
  });

  describe("createCheckoutSession - via provider", () => {
    test("returns null when session has no URL", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.checkout.sessions, "create", () =>
            Promise.resolve({
              id: "cs_multi_nourl",
              object: "checkout.session",
              url: null,
            } as never),
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
      const origFn = stripeApi.createCheckoutSession;
      stripeApi.createCheckoutSession = () =>
        Promise.reject(new TypeError("unexpected"));
      try {
        const result = await stripePaymentProvider.createCheckoutSession(
          checkoutIntent({ email: "john@example.com", name: "John" }),
          "http://localhost:3000",
        );
        expect(result).toBeNull();
      } finally {
        stripeApi.createCheckoutSession = origFn;
      }
    });
  });

  describe("resolveWebhookSession", () => {
    test("extracts session directly from listing with complete metadata", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            amount_total: 2000,
            id: "cs_resolve_1",
            metadata: {
              email: "alice@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Alice",
            },
            payment_intent: "pi_resolve_1",
            payment_status: "paid",
          },
        },
        id: "evt_resolve_1",
        type: "checkout.session.completed",
      });
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
        const result = await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              id: "cs_no_meta",
              // No payment_status or metadata
            },
          },
          id: "evt_no_meta",
          type: "checkout.session.completed",
        });
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

    test("returns retry when a paid listing has no payment intent", async () => {
      const result = await stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            amount_total: 2000,
            id: "cs_missing_intent",
            metadata: {
              email: "alice@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Alice",
            },
            payment_status: "paid",
          },
        },
        id: "evt_missing_intent",
        type: "checkout.session.completed",
      });
      expect(result).toBe("retry");
    });
  });
});
