import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  lineFor,
  stripeCheckoutSession,
  stripeClient,
} from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  asSession,
  BLANK_SESSION_METADATA,
} from "#test-utils/payment-session.ts";

describeStripe("stripe-provider", () => {
  test("identifies its Stripe webhook contract", () => {
    expect(stripePaymentProvider.checkoutCompletedEventType).toBe(
      "checkout.session.completed",
    );
    expect(stripePaymentProvider.requiresWebhookSignature).toBe(true);
    expect(stripePaymentProvider.type).toBe("stripe");
  });

  /** Stub `checkout.sessions.retrieve` with `impl`, then run `body`. */
  const whileRetrieving = (
    client: Awaited<ReturnType<typeof stripeClient>>,
    impl: Awaited<
      ReturnType<typeof stripeClient>
    >["checkout"]["sessions"]["retrieve"],
    body: () => void | Promise<void>,
  ) => withMocks(() => stub(client.checkout.sessions, "retrieve", impl), body);

  describe("toCheckoutResult - session with no URL", () => {
    /** The checkout should collapse to null when the SDK create behaves badly. */
    const expectNullCheckout = (
      client: Awaited<ReturnType<typeof stripeClient>>,
      createImpl: Awaited<
        ReturnType<typeof stripeClient>
      >["checkout"]["sessions"]["create"],
    ) =>
      withMocks(
        () => stub(client.checkout.sessions, "create", createImpl),
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
        Promise.resolve(
          stripeCheckoutSession({
            id: "cs_no_url",
            url: null,
          }),
        ),
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
    test("returns null for session without items", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              id: "cs_no_items",
              metadata: {
                email: "test@example.com",
                name: "Test User",
                // No items field
              },
              payment_intent: "pi_test_123",
            }),
          ),
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
          Promise.resolve(
            stripeCheckoutSession({
              id: "cs_no_meta",
              metadata: {
                items: '[{"e":1,"q":1,"p":0}]',
                // Missing name and email
              },
            }),
          ),
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
          Promise.resolve(
            stripeCheckoutSession({
              id: "cs_multi",
              metadata: {
                email: "multi@example.com",
                items: '[{"e":1,"q":2}]',
                name: "Multi User",
                phone: "+44 7700 900000",
              },
              payment_intent: "pi_multi_123",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_multi");
          expect(result).not.toBeNull();
          expect(asSession(result).id).toBe("cs_multi");
          expect(asSession(result).metadata.items).toBe('[{"e":1,"q":2}]');
          expect(asSession(result).metadata.phone).toBe("+44 7700 900000");
        },
      );
    });

    test("uses the id from an expanded PaymentIntent", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              metadata: {
                email: "expanded@example.com",
                items: '[{"e":1,"q":1}]',
                name: "Expanded Intent",
              },
              payment_intent: { id: "pi_expanded" },
            }),
          ),
        async () => {
          expect(
            asSession(await stripePaymentProvider.retrieveSession("cs_test"))
              .paymentReference,
          ).toBe("pi_expanded");
        },
      );
    });

    test("returns valid session for single-listing checkout", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              id: "cs_single",
              metadata: {
                email: "single@example.com",
                items: '[{"e":42,"q":2,"p":0}]',
                name: "Single User",
              },
              payment_intent: "pi_single_123",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_single");
          expect(result).not.toBeNull();
          expect(asSession(result).id).toBe("cs_single");
          expect(asSession(result).paymentStatus).toBe("paid");
          expect(asSession(result).paymentReference).toBe("pi_single_123");
          expect(asSession(result).metadata.items).toBe(
            '[{"e":42,"q":2,"p":0}]',
          );
        },
      );
    });

    test("returns amountTotal when session has numeric amount_total", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              amount_total: 4500,
              id: "cs_with_amount",
              metadata: {
                email: "amount@example.com",
                items: '[{"e":10,"q":3,"p":0}]',
                name: "Amount User",
              },
              payment_intent: "pi_with_amount",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_with_amount");
          expect(result).not.toBeNull();
          expect(asSession(result).amountTotal).toBe(4500);
          expect(asSession(result).paymentReference).toBe("pi_with_amount");
        },
      );
    });

    test("returns a refundable rejection when the session has no currency", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              currency: null,
              id: "cs_no_currency",
              metadata: {
                email: "nocur@example.com",
                items: '[{"e":10,"q":1,"p":0}]',
                name: "No Cur",
              },
              payment_intent: "pi_no_currency",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_no_currency");
          // A missing currency is refused at the boundary: it is not defaulted
          // to the site's, and the charge cannot be trusted without one.
          expect(result).toEqual({
            metadata: {
              ...BLANK_SESSION_METADATA,
              email: "nocur@example.com",
              items: '[{"e":10,"q":1,"p":0}]',
              name: "No Cur",
            },
            paymentReference: "pi_no_currency",
            reason: "malformed_charge",
            refundable: true,
          });
        },
      );
    });

    test("returns a refundable rejection when amount_total is null", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              amount_total: null,
              id: "cs_null_amount",
              metadata: {
                email: "nullamount@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Null Amount User",
              },
              payment_intent: "pi_null_amount",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_null_amount");
          expect(result).toEqual({
            metadata: {
              ...BLANK_SESSION_METADATA,
              email: "nullamount@example.com",
              items: '[{"e":1,"q":1,"p":0}]',
              name: "Null Amount User",
            },
            paymentReference: "pi_null_amount",
            reason: "malformed_charge",
            refundable: true,
          });
        },
      );
    });

    test("normalizes the Stripe creation time", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              amount_total: 7500,
              created: 123,
              id: "cs_amount_cast",
              metadata: {
                email: "cast@example.com",
                items: '[{"e":11,"q":1,"p":0}]',
                name: "Cast User",
              },
              payment_intent: "pi_amount_cast",
            }),
          ),
        async () => {
          const result =
            await stripePaymentProvider.retrieveSession("cs_amount_cast");
          expect(result).not.toBeNull();
          expect(asSession(result).amountTotal).toBe(7500);
          expect(asSession(result).createdAt).toBe("1970-01-01T00:02:03.000Z");
        },
      );
    });
  });
});
