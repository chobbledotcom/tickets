import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
} from "#shared/payment-helpers.ts";
import type { StripeCheckoutSessionCreateParams } from "#shared/stripe/client.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  lineFor,
  stripeCharge,
  stripeCheckoutSession,
  stripeClient,
  stripePaymentIntent,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import {
  checkoutIntent,
  checkoutItem,
  preparedCheckout,
} from "#test-utils/checkout.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";

describeStripe("stripe", () => {
  describe("client", () => {
    test("returns null when stripe key not set", async () => {
      const client = await stripeClientRuntime.get();
      expect(client).toBeNull();
    });

    test("returns client when stripe key is set in database", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client = await stripeClientRuntime.get();
      expect(client).not.toBeNull();
    });

    test("returns same client on subsequent calls", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client1 = await stripeClientRuntime.get();
      const client2 = await stripeClientRuntime.get();
      expect(client1).toBe(client2);
    });
  });

  describe("client configuration", () => {
    test("returns null after the key is removed", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      const client1 = await stripeClientRuntime.get();
      expect(client1).not.toBeNull();

      // Reset DB to clear the stripe key
      resetDb();
      await createTestDb();

      const client2 = await stripeClientRuntime.get();
      expect(client2).toBeNull();
    });
  });

  describe("retrieveCheckoutSession", () => {
    test("returns null when stripe key not set", async () => {
      const result = await stripeApi.retrieveCheckoutSession("cs_test_123");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      // Spy on the checkout.sessions.retrieve method and make it throw
      await withMocks(
        () =>
          stub(client.checkout.sessions, "retrieve", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (retrieveSpy) => {
          const result = await stripeApi.retrieveCheckoutSession("cs_test_123");
          expect(result).toBeNull();
          expect(retrieveSpy.calls[0]!.args).toEqual(["cs_test_123"]);
        },
      );
    });
  });

  describe("retrievePaymentIntent", () => {
    test("expands and narrows the latest charge", async () => {
      const client = await stripeClient();
      const intent = stripePaymentIntent({
        id: "pi_refunded",
        latest_charge: stripeCharge({
          payment_intent: "pi_refunded",
          refunded: true,
        }),
      });
      await withMocks(
        () =>
          stub(client.paymentIntents, "retrieveWithLatestCharge", () =>
            Promise.resolve(intent),
          ),
        async (retrieveSpy) => {
          const result = await stripeApi.retrievePaymentIntent("pi_refunded");
          expect(result).toEqual(intent);
          expect(retrieveSpy.calls[0]?.args).toEqual(["pi_refunded"]);
        },
      );
    });
  });

  describe("mock configuration", () => {
    test("creates client with mock config when STRIPE_MOCK_HOST is set", async () => {
      // This test exercises the getMockConfig code path
      await settings.update.stripe.secretKey("sk_test_123");
      Deno.env.set("STRIPE_MOCK_HOST", "localhost");
      Deno.env.set("STRIPE_MOCK_PORT", "12111");

      // This will create a client with mock config, but won't make any API calls
      const client = await stripeClientRuntime.get();
      expect(client).not.toBeNull();
    });

    test("uses default port 12111 when STRIPE_MOCK_PORT not set", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      Deno.env.set("STRIPE_MOCK_HOST", "localhost");
      Deno.env.delete("STRIPE_MOCK_PORT");

      const client = await stripeClientRuntime.get();
      expect(client).not.toBeNull();
    });
  });

  describe("stripe-mock integration", () => {
    // These tests use the stripe-mock host and port chosen by the harness.

    test("creates checkout session with intent metadata", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      const listing = testListing({ max_quantity: 5, unit_price: 1000 });
      const session = await stripeApi.createCheckout(
        await preparedCheckout(
          checkoutIntent({
            email: "john@example.com",
            items: [lineFor(listing, 2)],
            name: "John Doe",
          }),
        ),
      );

      expect(session?.id).toMatch(/^cs_test_/u);
      expect(session?.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    });

    test("refunds payment with stripe-mock", async () => {
      await settings.update.stripe.secretKey("sk_test_mock");

      // stripe-mock accepts any payment_intent ID
      const refund = await stripeApi.requestRefund("pi_test_123", "refund-key");

      expect(refund?.id).toMatch(/^re_/u);
      expect(refund?.status).toBe("succeeded");
    });
  });

  describe("createCheckout", () => {
    /** Stub `sessions.create` to resolve `session`, handing the spy to `run`. */
    const withCreateSpy = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      session: ReturnType<typeof stripeCheckoutSession>,
      run: (
        getParams: () => StripeCheckoutSessionCreateParams,
        getIdempotencyKey: () => string | undefined,
      ) => Promise<void>,
    ): Promise<void> =>
      withMocks(
        () =>
          stub(client.checkout.sessions, "create", () =>
            Promise.resolve(session),
          ),
        async (createSpy) => {
          await run(
            () => {
              const params = createSpy.calls[0]?.args[0];
              if (!params) throw new Error("Stripe checkout was not created");
              return params;
            },
            () => createSpy.calls[0]?.args[1],
          );
        },
      );

    test("returns null when stripe key not set", async () => {
      const result = await stripeApi.createCheckout(
        await preparedCheckout(
          checkoutIntent({
            email: "john@example.com",
            items: [checkoutItem({ name: "Test", slug: "test-listing" })],
            name: "John",
          }),
        ),
      );
      expect(result).toBeNull();
    });

    test("includes booking fee line item when fee is set", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.bookingFee("5");
      const client = await stripeClient();

      await withCreateSpy(
        client,
        stripeCheckoutSession({
          id: "cs_fee",
          url: "https://checkout.stripe.com/fee",
        }),
        async (getParams, getIdempotencyKey) => {
          const listing = testListing({ unit_price: 1000 });
          await stripeApi.createCheckout(
            await preparedCheckout(
              checkoutIntent({
                email: "jane@example.com",
                items: [lineFor(listing)],
                name: "Jane",
              }),
            ),
          );

          const params = getParams();
          expect(getIdempotencyKey()).toBe("local-payment-test");
          const feeItem = params.line_items.find(
            (li) => li.price_data.product_data.name === "Booking fee",
          );
          const ticketItem = params.line_items.find((li) =>
            li.price_data.product_data.name.startsWith("Ticket:"),
          );
          expect(params.customer_email).toBe("jane@example.com");
          expect(ticketItem?.price_data.product_data.description).toBe(
            "Ticket",
          );
          expect(feeItem).toMatchObject({
            price_data: { unit_amount: 50 },
            quantity: 1,
          });
        },
      );
    });

    test("charges the deposit per ticket but the fee on the full order", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.bookingFee("5");
      const client = await stripeClient();

      await withCreateSpy(
        client,
        stripeCheckoutSession({
          id: "cs_dep",
          url: "https://checkout.stripe.com/dep",
        }),
        async (getParams) => {
          const listing = testListing({ unit_price: 1000 });
          await stripeApi.createCheckout(
            await preparedCheckout(
              checkoutIntent({
                email: "jane@example.com",
                items: [lineFor(listing, 2)],
                name: "Jane",
                // Public-default reservation charges a 10% deposit up front.
                reservationAmount: "10%",
              }),
            ),
          );

          const params = getParams();
          const ticketItem = params.line_items.find((li) =>
            li.price_data.product_data.name.startsWith("Ticket:"),
          );
          const feeItem = params.line_items.find(
            (li) => li.price_data.product_data.name === "Booking fee",
          );
          if (!ticketItem || !feeItem) {
            throw new Error("Stripe checkout line items were not created");
          }
          // Ticket line is charged the per-unit deposit (10% of £10.00 = £1.00).
          expect(ticketItem.price_data.unit_amount).toBe(100);
          expect(ticketItem.quantity).toBe(2);
          expect(ticketItem.price_data.product_data.description).toBe(
            "2 Tickets",
          );
          // Fee is still 5% of the full £20.00 order, not of the deposit.
          expect(feeItem.price_data.unit_amount).toBe(100);
          // Metadata records the FULL line price + the snapshot so the webhook
          // can re-derive the deposit and compute the outstanding balance. The
          // snapshot is packed into `b` on the wire; decode it the way the
          // webhook does rather than reading the raw entry.
          if (!hasRequiredSessionMetadata(params.metadata)) {
            throw new Error("Stripe checkout metadata was incomplete");
          }
          const metadata = extractSessionMetadata(params.metadata);
          expect(JSON.parse(metadata.items)).toEqual([
            { e: listing.id, p: 2000, q: 2 },
          ]);
          expect(metadata.reservation_amount).toBe("10%");
        },
      );
    });

    test("omits customer email when the checkout has no email", async () => {
      const client = await stripeClient();

      await withCreateSpy(
        client,
        stripeCheckoutSession({
          id: "cs_no_email",
          url: "https://checkout.stripe.com/no-email",
        }),
        async (getParams) => {
          await stripeApi.createCheckout(
            await preparedCheckout(
              checkoutIntent({
                email: "",
                items: [checkoutItem({ name: "No email", slug: "no-email" })],
                name: "No Email User",
              }),
            ),
          );

          const params = getParams();
          expect(params).not.toHaveProperty("customer_email");
        },
      );
    });
  });

  describe("requestRefund", () => {
    test("returns null when stripe key not set", async () => {
      const result = await stripeApi.requestRefund("pi_test_123", "refund-key");
      expect(result).toBeNull();
    });

    test("returns null when Stripe API throws error", async () => {
      const client = await stripeClient();
      await withMocks(
        () =>
          stub(client.refunds, "create", () =>
            Promise.reject(new Error("Network error")),
          ),
        async (refundSpy) => {
          const result = await stripeApi.requestRefund(
            "pi_test_123",
            "refund-key",
          );
          expect(result).toBeNull();
          expect(refundSpy.calls.length).toBeGreaterThan(0);
        },
      );
    });
  });
});
