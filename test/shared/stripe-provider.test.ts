import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  lineFor,
  stripeCheckoutSession,
  stripeClient,
} from "#test/lib/stripe/fixtures.ts";
import { describeStripe } from "#test/lib/stripe/harness.ts";
import { checkoutIntent } from "#test-utils/checkout.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { testListing } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";

describeStripe("stripe-provider", () => {
  const errors = setupErrorSpy();

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
    test("returns null when a paid session has no payment intent", async () => {
      const client = await stripeClient();
      await whileRetrieving(
        client,
        () =>
          Promise.resolve(
            stripeCheckoutSession({
              id: "cs_paid_without_intent",
              metadata: {
                email: "alice@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Alice",
              },
              payment_intent: null,
            }),
          ),
        async () => {
          expect(
            await stripePaymentProvider.retrieveSession(
              "cs_paid_without_intent",
            ),
          ).toBeNull();
        },
      );
    });

    test("retries a paid webhook session with no payment intent", async () => {
      const fetched = stripeCheckoutSession({
        id: "cs_webhook_without_intent",
        metadata: {
          email: "buyer@example.com",
          items: '[{"e":1,"q":1,"p":0}]',
          name: "Buyer",
        },
        payment_intent: null,
      });
      const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(fetched),
      );
      try {
        expect(
          await stripePaymentProvider.resolveWebhookSession({
            data: {
              object: fetched,
            },
            id: "evt_webhook_without_intent",
            type: "checkout.session.completed",
          }),
        ).toBe("retry");
        expect(errors.lastMessage()).toContain(
          "Stripe checkout cs_webhook_without_intent is paid but has no payment intent",
        );
      } finally {
        retrieve.restore();
      }
    });

    test("processes a webhook session whose snapshot lacked a payment intent but the fetched session has one", async () => {
      const fetched = stripeCheckoutSession({
        id: "cs_webhook_late_intent",
        metadata: {
          email: "buyer@example.com",
          items: '[{"e":1,"q":1,"p":0}]',
          name: "Buyer",
        },
        payment_intent: "pi_late_123",
      });
      const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(fetched),
      );
      try {
        const result = await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: stripeCheckoutSession({
              id: "cs_webhook_late_intent",
              metadata: {
                email: "buyer@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Buyer",
              },
              payment_intent: null,
            }),
          },
          id: "evt_webhook_late_intent",
          type: "checkout.session.completed",
        });
        expect(result).toMatchObject({
          id: "cs_webhook_late_intent",
          paymentReference: "pi_late_123",
        });
      } finally {
        retrieve.restore();
      }
    });

    test("accepts a one-character Stripe session id", async () => {
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: stripeCheckoutSession({
              id: "x",
              metadata: {
                email: "buyer@example.com",
                items: '[{"e":1,"q":1,"p":0}]',
                name: "Buyer",
              },
            }),
          },
          id: "evt_short_session",
          type: "checkout.session.completed",
        }),
      ).toMatchObject({ id: "x" });
    });

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
          expect(result?.amountTotal).toBe(4500);
          expect(result?.paymentReference).toBe("pi_with_amount");
        },
      );
    });

    test("returns null when amount_total is null", async () => {
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
          expect(result).toBeNull();
        },
      );
    });

    test("throws for an invalid webhook payment status", async () => {
      await expect(
        stripePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              ...stripeCheckoutSession({ id: "cs_bad_status" }),
              payment_status: "completed",
            },
          },
          id: "evt_bad_status",
          type: "checkout.session.completed",
        }),
      ).rejects.toThrow();
    });

    test("throws for malformed checkout fields when the webhook has a session ID", async () => {
      await expect(
        stripePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              ...stripeCheckoutSession({ id: "cs_bad_amount" }),
              amount_total: "1000",
            },
          },
          id: "evt_bad_amount",
          type: "checkout.session.completed",
        }),
      ).rejects.toThrow();
    });

    test("returns null for a webhook checkout object without a session ID", async () => {
      const { id: _id, ...withoutId } = stripeCheckoutSession();
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: { object: withoutId },
          id: "evt_without_session",
          type: "checkout.session.completed",
        }),
      ).toBeNull();
    });

    test("keeps a valid foreign checkout session ignored", async () => {
      const foreign = stripeCheckoutSession({
        id: "cs_foreign",
        metadata: { foreign: "metadata" },
      });
      const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(foreign),
      );
      try {
        expect(
          await stripePaymentProvider.resolveWebhookSession({
            data: { object: foreign },
            id: "evt_foreign",
            type: "checkout.session.completed",
          }),
        ).toBeNull();
        expect(retrieve.calls[0]?.args).toEqual(["cs_foreign"]);
      } finally {
        retrieve.restore();
      }
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
          expect(result?.amountTotal).toBe(7500);
          expect(result?.createdAt).toBe("1970-01-01T00:02:03.000Z");
        },
      );
    });
  });

  describe("isPaymentRefunded", () => {
    test("returns true when latest_charge is refunded", async () => {
      const retrieve = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve({
          id: "pi_1",
          latest_charge: { refunded: true },
        }),
      );
      try {
        expect(await stripePaymentProvider.isPaymentRefunded("pi_1")).toBe(
          true,
        );
      } finally {
        retrieve.restore();
      }
    });

    test("returns false when latest_charge is not refunded", async () => {
      const retrieve = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve({
          id: "pi_2",
          latest_charge: { refunded: false },
        }),
      );
      try {
        expect(await stripePaymentProvider.isPaymentRefunded("pi_2")).toBe(
          false,
        );
      } finally {
        retrieve.restore();
      }
    });

    test("returns false when payment intent not found", async () => {
      const retrieve = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve(null),
      );
      try {
        expect(await stripePaymentProvider.isPaymentRefunded("pi_3")).toBe(
          false,
        );
      } finally {
        retrieve.restore();
      }
    });
  });
});
